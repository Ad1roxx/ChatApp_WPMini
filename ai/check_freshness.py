"""End-to-end check: how quickly the index follows the app, and that it is never wrong.

    python check_freshness.py            # about five minutes; needs both MongoDBs running
    python check_freshness.py --quick    # fewer repetitions, for a smoke test
    python check_freshness.py --contention   # other users' search while the worker embeds

It starts the real Express server and the real retrieval service itself, both
pointed at a fixture database of their own (`chatapp_freshness` on each MongoDB)
- never `chatapp` and never the served index; the evaluation fixture is read,
for one measurement, and never written - and
drives them only through the app's HTTP routes, as a browser would. Then it
measures what S1.5 promises:

- **upload -> searchable**: from the upload route's response until the Copilot
  route returns the file, for a small PDF, one near the 10 MB limit, and a
  long text-heavy one;
- **delete -> unsearchable**: from the delete route's response until it is gone.
  The read-time check should make this immediate, and the check proves it by
  deleting while the sync worker is busy with something else - so the deletion's
  own sync cannot have run yet.

And it asserts correctness throughout: the two parties find what is theirs, an
outsider is refused, and nothing deleted is ever returned.
"""

from __future__ import annotations

import json
import os
import secrets
import tempfile
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pymupdf
from bson import ObjectId
from pymongo import MongoClient

AI_ROOT = Path(__file__).resolve().parent
SERVER_ROOT = AI_ROOT.parent / "server"

FIXTURE = "chatapp_freshness"
APP_MONGO = "mongodb://127.0.0.1:27017/?directConnection=true"
CHUNK_MONGO = "mongodb://127.0.0.1:27018/?directConnection=true"
AI_PORT = 8766
APP_PORT = 3299
AI = f"http://127.0.0.1:{AI_PORT}"
APP = f"http://127.0.0.1:{APP_PORT}"
SECRET = secrets.token_hex(16)
SERVICE_LOG = Path(tempfile.gettempdir()) / "check_freshness.service.log"

MENTOR = "0000000000000000000000f1"
STUDENT = "0000000000000000000000f2"
OUTSIDER = "0000000000000000000000f3"  # a student, in nobody's mentorship here

BRIEF = (
    "The submission must include an invalidation rule written as a comment, and a "
    "short explanation of which entries become stale when an item is added to the "
    "reading list. It should also describe what happens when two requests arrive "
    "together on a cold cache, which is the case most implementations get wrong."
)
QUERY = "what must the invalidation rule say about stale entries on a cold cache?"

failures: list[str] = []


def check(what: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {what}")
    if detail:
        print(f"       {detail}")
    if not ok:
        failures.append(what)


# --------------------------------------------------------------------------
# Files
# --------------------------------------------------------------------------
def small_pdf(marker: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_textbox(pymupdf.Rect(56, 56, 540, 760), f"Requirements\n\n{BRIEF} Ref {marker}.", fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


def large_pdf(marker: str, target_mb: float = 9.5) -> bytes:
    """Near the 10 MB limit the way a real report gets there: a few pages of
    text, and images. Noise images, because they do not compress - so the file
    really is this size on the wire and in GridFS."""
    doc = pymupdf.open()
    for n in range(5):
        page = doc.new_page()
        page.insert_textbox(
            pymupdf.Rect(56, 56, 540, 760), f"Section {n + 1}\n\n{BRIEF} Ref {marker}.", fontsize=11
        )
    # 600 x 600 noise is about 1 MB a page: fine enough steps to land near the
    # target without crossing the route's 10 MB limit.
    while len(doc.tobytes()) < (target_mb - 1.1) * 1024 * 1024:
        page = doc.new_page()
        noise = pymupdf.Pixmap(pymupdf.csRGB, 600, 600, os.urandom(600 * 600 * 3), False)
        page.insert_image(page.rect, pixmap=noise)
    data = doc.tobytes()
    doc.close()
    return data


def long_pdf(marker: str, pages: int = 50) -> bytes:
    """Text on every page: what makes indexing slow is text to embed, not bytes."""
    doc = pymupdf.open()
    for n in range(pages):
        page = doc.new_page()
        page.insert_textbox(
            pymupdf.Rect(56, 56, 540, 760),
            f"{n + 1}. Part {n + 1}\n\n" + " ".join([BRIEF] * 4) + f" Ref {marker}.",
            fontsize=10,
        )
    data = doc.tobytes()
    doc.close()
    return data


# --------------------------------------------------------------------------
# HTTP, as a browser would
# --------------------------------------------------------------------------
def call(method: str, path: str, as_user: str, body=None, raw: bytes | None = None, headers=None):
    h = {"X-Dev-User-Id": as_user, **(headers or {})}
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(APP + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            text = res.read()
            return res.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as err:
        return err.code, None


def upload(sid: str, name: str, data: bytes):
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
        f"Content-Type: application/pdf\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    return call(
        "POST",
        f"/api/submissions/{sid}/files",
        STUDENT,
        raw=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )


def search(as_user: str, mentorship: str) -> tuple[int, list[dict]]:
    status, body = call(
        "POST", f"/api/mentorships/{mentorship}/copilot/search", as_user, {"query": QUERY, "k": 10}
    )
    return status, (body or {}).get("chunks", [])


def has(as_user: str, mentorship: str, title: str) -> bool:
    status, chunks = search(as_user, mentorship)
    assert status == 200, f"search answered {status}"
    return any(c["title"] == title for c in chunks)


def until(predicate, timeout: float = 120.0, every: float = 0.05) -> tuple[float | None, int]:
    """Seconds until `predicate()` holds, and how many polls that took."""
    started = time.perf_counter()
    polls = 0
    while time.perf_counter() - started < timeout:
        polls += 1
        if predicate():
            return time.perf_counter() - started, polls
        time.sleep(every)
    return None, polls


# --------------------------------------------------------------------------
# The fixture and the two services
# --------------------------------------------------------------------------
def seed() -> None:
    for uri in (APP_MONGO, CHUNK_MONGO):
        MongoClient(uri)[FIXTURE].client.drop_database(FIXTURE)
    users = MongoClient(APP_MONGO)[FIXTURE].users
    now = datetime.now(timezone.utc)
    users.insert_many(
        [
            {
                "_id": ObjectId(uid),
                "firebaseUid": f"fresh-{uid}",
                "email": f"{name}@freshness.local",
                "displayName": name.title(),
                "photoURL": "",
                "role": role,
                "isOnline": False,
                "bio": "",
                "expertise": "",
                "availability": "",
                "createdAt": now,
            }
            for uid, name, role in (
                (MENTOR, "mentor", "mentor"),
                (STUDENT, "student", "student"),
                (OUTSIDER, "outsider", "student"),
            )
        ]
    )


def start() -> list[subprocess.Popen]:
    ai_env = {
        **os.environ,
        "AI_MONGODB_URI": CHUNK_MONGO,
        "AI_DB_NAME": FIXTURE,
        "AI_APP_MONGODB_URI": APP_MONGO,
        "AI_APP_DB_NAME": FIXTURE,
        "AI_SERVICE_SECRET": SECRET,
        "AI_CATCHUP": "off",
    }
    app_env = {
        **os.environ,
        "PORT": str(APP_PORT),
        "MONGODB_URI": f"mongodb://127.0.0.1:27017/{FIXTURE}",
        "FIREBASE_PROJECT_ID": "freshness-check",
        "ALLOW_DEV_AUTH": "true",
        "AI_SERVICE_URL": AI,
        "AI_SERVICE_SECRET": SECRET,
    }
    log = open(SERVICE_LOG, "w", encoding="utf-8")
    procs = [
        subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(AI_PORT)],
            cwd=AI_ROOT,
            env=ai_env,
            stdout=log,
            stderr=subprocess.STDOUT,
        ),
        subprocess.Popen(
            ["node", "index.js"], cwd=SERVER_ROOT, env=app_env, stdout=log, stderr=subprocess.STDOUT
        ),
    ]
    def up(url):
        """Any HTTP answer means the server is listening - including the 401 an
        unauthenticated request to the app gets, which is how the Node test
        harness waits for it too."""
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except urllib.error.HTTPError:
            return True
        except Exception:  # noqa: BLE001 - not listening yet
            return False

    # The service builds its vector index on start-up, which can take a minute.
    waited, _ = until(lambda: up(f"{AI}/health") and up(f"{APP}/api/announcements"), timeout=300, every=0.5)
    if waited is None:
        for p in procs:
            p.terminate()
        raise SystemExit(f"the services did not start - see {SERVICE_LOG}")
    return procs


def stop(procs) -> None:
    for p in procs:
        p.terminate()
        p.wait(timeout=30)
    for uri in (APP_MONGO, CHUNK_MONGO):
        MongoClient(uri).drop_database(FIXTURE)


def check_cost_across_servers() -> None:
    """The read-time check's cost where it actually runs: records on the app's
    MongoDB (27017), chunks on the container (27018).

    The evaluation measures it with both on the container. Here the evaluation
    fixture's records are copied to 27017, the questions run against the
    evaluation's own index, and the check reads across the network hop the
    served path has. Same records, so it must drop nothing.
    """
    import appdb
    from config import EVAL_DB_NAME
    from evaluate import by_group, evaluate, load_questions
    from store import ChunkStore

    copy = f"{FIXTURE}_records"
    source = MongoClient(CHUNK_MONGO)[EVAL_DB_NAME]
    target = MongoClient(APP_MONGO)[copy]
    target.client.drop_database(copy)
    for name in ("mentorships", "assignments", "submissions", "goals", "resources"):
        docs = list(source[name].find())
        if docs:
            target[name].insert_many(docs)
    try:
        store = ChunkStore(db_name=EVAL_DB_NAME, records=appdb.connect(APP_MONGO, copy))
        for group, questions in by_group(load_questions()).items():
            r = evaluate(store, questions, rerank=False, diversity="soft_cap")
            print(
                f"  {group:<10} search {r['median_latency_ms']:>5.0f} ms median, of which the check "
                f"{r['median_check_ms']:>5.1f} ms; {r['dropped']} dropped; recall@1 {r['recall'][1]:.2f}"
            )
            check(f"{group}: the check dropped nothing across servers", r["dropped"] == 0)
    finally:
        target.client.drop_database(copy)


def p95(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[max(0, int(round(0.95 * len(ordered))) - 1)]


# --------------------------------------------------------------------------
# The measurements
# --------------------------------------------------------------------------
def measure(label: str, make, runs: int, sid: str, mentorship: str, results: dict) -> None:
    add, gone, first_poll = [], [], 0
    size = len(make("size"))
    for n in range(runs):
        name = f"{label}-{n}.pdf"
        status, _ = upload(sid, name, make(f"{label}{n}"))
        assert status == 201, f"upload answered {status}"
        took, _ = until(lambda: has(STUDENT, mentorship, name))
        if took is None:
            check(f"{name} became searchable", False, "not within two minutes")
            return
        add.append(took)

        sub = call("GET", f"/api/mentorships/{mentorship}/assignments", STUDENT)[1][0]
        file_id = next(a["fileId"] for a in sub["attachments"] if a["name"] == name)
        status, _ = call("DELETE", f"/api/submissions/{sid}/files/{file_id}", STUDENT)
        assert status == 200, f"delete answered {status}"
        took, polls = until(lambda: not has(STUDENT, mentorship, name))
        gone.append(took)
        first_poll += polls == 1
    results[label] = {"size_mb": size / (1024 * 1024), "add": add, "gone": gone, "first_poll": first_poll}


def contention(uploads: int = 5) -> None:
    """Another user's search latency while the worker embeds a long PDF.

    The sync worker shares the service's process with search, so a long upload
    competes with everyone's questions for the CPU. Measured, not assumed: one
    student searches their own mentorship, through the Copilot route, while a
    different student's fifty-page PDF is being embedded.

    The embedding window is observed directly rather than guessed:
    `replace_source` inserts a file's chunks only after all of them are
    embedded, so the window runs from the upload route's response until those
    chunks appear in the chunk store.
    """
    seed()
    procs = start()
    chunks = MongoClient(CHUNK_MONGO)[FIXTURE].knowledge_chunks

    def search_ms(user, mentorship) -> float:
        started = time.perf_counter()
        status, _ = search(user, mentorship)
        assert status == 200, f"search answered {status}"
        return (time.perf_counter() - started) * 1000

    try:
        due = datetime.fromtimestamp(time.time() + 7 * 86400, timezone.utc).isoformat()
        uploader = call("POST", "/api/mentorships", MENTOR, {"studentId": STUDENT, "topic": "A"})[1]["_id"]
        other = call("POST", "/api/mentorships", MENTOR, {"studentId": OUTSIDER, "topic": "B"})[1]["_id"]
        call(
            "POST",
            "/api/assignments",
            MENTOR,
            {"title": "Caching exercise", "instructions": BRIEF, "dueAt": due, "mentorshipIds": [uploader, other]},
        )
        sid = call("GET", f"/api/mentorships/{uploader}/assignments", STUDENT)[1][0]["_id"]
        until(lambda: search(OUTSIDER, other)[1] != [], timeout=60)
        for _ in range(10):  # warm both paths before measuring anything
            search_ms(OUTSIDER, other)

        idle = [search_ms(OUTSIDER, other) for _ in range(200)]

        busy, windows = [], []
        for n in range(uploads):
            name = f"long-{n}.pdf"
            status, _ = upload(sid, name, long_pdf(f"busy{n}"))
            assert status == 201, f"upload answered {status}"
            started = time.perf_counter()
            while chunks.count_documents({"title": name}) == 0:
                busy.append(search_ms(OUTSIDER, other))
                if time.perf_counter() - started > 120:
                    raise SystemExit(f"{name} was never indexed")
            windows.append(time.perf_counter() - started)
            sub = call("GET", f"/api/mentorships/{uploader}/assignments", STUDENT)[1][0]
            file_id = next(a["fileId"] for a in sub["attachments"] if a["name"] == name)
            call("DELETE", f"/api/submissions/{sid}/files/{file_id}", STUDENT)
            time.sleep(2)  # let the deletion's sync finish before the next window
    finally:
        stop(procs)

    def row(label, xs):
        print(
            f"  {label:<34} n={len(xs):>4}   median {statistics.median(xs):6.1f} ms"
            f"   p95 {p95(xs):6.1f} ms   max {max(xs):6.1f} ms"
        )

    print("another user's search latency, through the Copilot route")
    row("worker idle", idle)
    row("worker embedding a 50-page PDF", busy)
    print(f"  embedding windows: {', '.join(f'{w:.2f} s' for w in windows)}")
    check(
        "searches stay far inside Express's 15 s timeout while the worker embeds",
        max(busy) < 15000,
        f"slowest {max(busy):.0f} ms",
    )


def main() -> None:
    if "--contention" in sys.argv:
        contention()
        print()
        if failures:
            print(f"{len(failures)} check(s) failed")
            sys.exit(1)
        print("all checks passed")
        return

    quick = "--quick" in sys.argv
    runs = {"small": 5 if quick else 20, "large": 2 if quick else 5, "long": 1 if quick else 3}

    print(f"fixture: {FIXTURE} on both servers; starting the app and the retrieval service")
    seed()
    procs = start()
    try:
        status, mentorship = call("POST", "/api/mentorships", MENTOR, {"studentId": STUDENT, "topic": "Caching"})
        mid = mentorship["_id"]
        due = datetime.fromtimestamp(time.time() + 7 * 86400, timezone.utc).isoformat()
        call("POST", "/api/assignments", MENTOR, {"title": "Caching exercise", "instructions": BRIEF, "dueAt": due, "mentorshipIds": [mid]})
        sid = call("GET", f"/api/mentorships/{mid}/assignments", STUDENT)[1][0]["_id"]

        # Correctness first: who finds what.
        print("\ncorrectness")
        status, _ = upload(sid, "shared.pdf", small_pdf("shared"))
        until(lambda: has(STUDENT, mid, "shared.pdf"))
        check("the student finds their upload", has(STUDENT, mid, "shared.pdf"))
        check("their mentor finds it", has(MENTOR, mid, "shared.pdf"))
        outsider_status, _ = search(OUTSIDER, mid)
        check("an outsider is refused by the route", outsider_status == 403, f"answered {outsider_status}")

        # The deletion that cannot have been synced yet: the worker is busy
        # extracting and embedding a long file when the deletion lands.
        upload(sid, "busy.pdf", long_pdf("busy"))
        shared_id = next(
            a["fileId"]
            for a in call("GET", f"/api/mentorships/{mid}/assignments", STUDENT)[1][0]["attachments"]
            if a["name"] == "shared.pdf"
        )
        call("DELETE", f"/api/submissions/{sid}/files/{shared_id}", STUDENT)
        gone_now = not has(STUDENT, mid, "shared.pdf") and not has(MENTOR, mid, "shared.pdf")
        # Proof the deletion's own sync had not run: its chunks are still in
        # the index. So it was the read-time check, alone, that hid them.
        still_indexed = MongoClient(CHUNK_MONGO)[FIXTURE].knowledge_chunks.count_documents(
            {"attachmentId": str(shared_id)}
        )
        check(
            "a deleted file is gone at the very next search, while its chunks are still in the index",
            gone_now and still_indexed > 0,
            f"chunks of the deleted file still indexed at that moment: {still_indexed}",
        )
        busy_id = next(
            a["fileId"]
            for a in call("GET", f"/api/mentorships/{mid}/assignments", STUDENT)[1][0]["attachments"]
            if a["name"] == "busy.pdf"
        )
        until(lambda: has(STUDENT, mid, "busy.pdf"))
        call("DELETE", f"/api/submissions/{sid}/files/{busy_id}", STUDENT)
        until(lambda: not has(STUDENT, mid, "busy.pdf"))

        print("\nfreshness")
        results: dict = {}
        measure("small", small_pdf, runs["small"], sid, mid, results)
        measure("large", large_pdf, runs["large"], sid, mid, results)
        measure("long", long_pdf, runs["long"], sid, mid, results)

        print(f"\n  {'file':<8} {'size':>8} {'n':>3}   upload -> searchable (median / p95)   delete -> gone (median / max)")
        for label, r in results.items():
            print(
                f"  {label:<8} {r['size_mb']:>6.2f}MB {len(r['add']):>3}   "
                f"{statistics.median(r['add']):>8.2f} s / {p95(r['add']):>6.2f} s"
                f"              {statistics.median(r['gone']) * 1000:>6.0f} ms / {max(r['gone']) * 1000:>4.0f} ms"
                f"   gone at first search: {r['first_poll']}/{len(r['gone'])}"
            )
            check(
                f"{label}: every deleted file was gone at the first search after the delete",
                r["first_poll"] == len(r["gone"]),
            )
    finally:
        stop(procs)

    print("\nthe read-time check across two servers (the served topology)")
    check_cost_across_servers()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
