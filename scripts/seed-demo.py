"""A demo mentorship world, entirely invented, built through the app's own routes.

    ai/.venv/Scripts/python.exe scripts/seed-demo.py            # needs the demo stack up
    npm run demo                                                # does all of it

A mentor and two students, in two active mentorships and one ended one, with
assignments, hand-ins with PDF and Word attachments, reviews, goals and resources.
Everything is written by calling Express as the person who would write it, so it
is indexed the normal way: each write notifies the service, exactly as in use.

The one exception is the three user records. An account comes from a Google
sign-in, which cannot be automated, so they are inserted directly, as the Node test
harness and `check_freshness.py` do. Nothing else touches the database directly
except the wipe that makes a re-run idempotent.

**Refuses to run** against any database but a demo one, and against a server that
is not serving that database: it signs in as a user it has just inserted there, and
a server looking at any other database does not know them.

Everyone and everything here is invented: synthetic data only (AGENT_PLAN 2.6).
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import docx
import httpx
import pymupdf
from bson import ObjectId
from pymongo import MongoClient

DEMO_DB = os.getenv("DEMO_DB", "chatapp_demo")
APP_MONGO = os.getenv("DEMO_APP_MONGO", "mongodb://127.0.0.1:27017/?directConnection=true")
CHUNK_MONGO = os.getenv("DEMO_CHUNK_MONGO", "mongodb://127.0.0.1:27018/?directConnection=true")
API = os.getenv("DEMO_API", "http://127.0.0.1:3101")

MENTOR = "00000000000000000000d001"
ROHAN = "00000000000000000000d002"
ANANYA = "00000000000000000000d003"

USERS = [
    (MENTOR, "Meera Iyer", "meera.iyer@demo.mentorconnect.invalid", "mentor",
     "Backend engineer. Mentors students moving from coursework to their first production systems."),
    (ROHAN, "Rohan Kapoor", "rohan.kapoor@demo.mentorconnect.invalid", "student",
     "Third-year CS student, building the campus canteen's ordering service."),
    (ANANYA, "Ananya Rao", "ananya.rao@demo.mentorconnect.invalid", "student",
     "Final-year student moving into data engineering."),
]

PDF_TYPE = "application/pdf"
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def assert_demo_database(name: str) -> None:
    """Only a database that says it is a demo one, and nothing else we own."""
    lowered = name.lower()
    if not lowered.endswith("_demo") or any(word in lowered for word in ("test", "eval", "rag", "fresh", "prod")):
        raise SystemExit(f"Refusing to seed '{name}': this script only writes to a database named *_demo.")


# ---------------------------------------------------------------- the files


def pdf(pages: list[list[tuple[str, str]]]) -> bytes:
    """Pages of (kind, text): `title` 20 pt, `h` 15 pt, `p` 11 pt body."""
    sizes = {"title": 20, "h": 15, "p": 11}
    document = pymupdf.open()
    for blocks in pages:
        page = document.new_page(width=595, height=842)
        y = 60
        for kind, text in blocks:
            size = sizes[kind]
            height = 28 if kind != "p" else (len(text) // 85 + 2) * 15
            rect = pymupdf.Rect(60, y, 535, y + height + size)
            page.insert_textbox(rect, " ".join(text.split()), fontsize=size, fontname="helv")
            y += height + (12 if kind == "p" else 6)
    return document.tobytes()


def word(blocks: list[tuple[str, str]]) -> bytes:
    """(kind, text): `title`, `h` for a real Heading 1, `p`, or `row` for a table row."""
    document = docx.Document()
    for kind, text in blocks:
        if kind == "title":
            document.add_heading(text, level=0)
        elif kind == "h":
            document.add_heading(text, level=1)
        else:
            document.add_paragraph(" ".join(text.split()))
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


RATE_LIMITER = pdf([
    [
        ("title", "Rate limiting the canteen ordering API"),
        ("p", "Rohan Kapoor. Design note for Meera Iyer."),
        ("h", "The problem"),
        ("p", """Between 12:25 and 12:40 on a weekday the ordering API takes about 900 requests a
        minute, against about 40 at any other time. Most are real students, but last term one
        badly written menu-refresh script on a phone polled every 200 milliseconds and, on its
        own, used more connections than the whole of the second-year timetable. There is no limit
        today, so a single client can starve everyone in the queue for lunch."""),
        ("h", "What a limit has to do"),
        ("p", """It should stop one client hurting the others without refusing a student who is
        placing a normal order. A person tapping quickly should never notice it. It has to work
        across the two application instances behind the load balancer, so a counter in process
        memory is not enough: each instance would allow the full rate and the real limit would
        double whenever we scale."""),
    ],
    [
        ("h", "Why a token bucket"),
        ("p", """I compared a fixed window, a sliding window log and a token bucket. A fixed window
        lets a client send twice the limit across a window boundary. A sliding log is exact but
        stores a timestamp per request, which at lunch is about 13,000 entries in Redis for no
        benefit we would notice. A token bucket stores two numbers per user, allows short bursts,
        and matches how people actually use a menu: several quick taps, then nothing."""),
        ("h", "The numbers"),
        ("p", """Each signed-in user gets a bucket of 20 tokens, refilled at one token every three
        seconds. Reading the menu costs one token and placing an order costs five, because an order
        takes a database transaction and a menu read comes from the cache. A client that runs out
        gets a 429 with a Retry-After header saying how many seconds until it can afford the
        request. Anonymous clients share a bucket per IP address, of 10 tokens."""),
        ("h", "Where the state lives"),
        ("p", """In Redis, under one key per user, updated by a small Lua script so that reading,
        refilling and spending are one atomic step. Keys expire after an hour without requests, so
        the memory used follows the number of active users rather than the number of accounts."""),
    ],
    [
        ("h", "When Redis is down"),
        ("p", """The limiter fails open: if Redis cannot be reached within 50 milliseconds, the
        request is allowed and a counter is incremented for the dashboard. Refusing every order
        because the limiter is broken would turn a small outage into a total one. The cost is that
        during a Redis outage nothing is limited, which I think is the right way round."""),
        ("h", "What I tested"),
        ("p", """A k6 script ran the lunch peak against a staging copy: 900 requests a minute from
        300 virtual students, plus one client polling every 200 milliseconds. Without the limiter the
        p95 for placing an order was 2.4 seconds. With it, the polling client was refused about 94
        per cent of the time and the p95 for everyone else came down to 310 milliseconds. No
        ordinary student in the test was ever refused."""),
        ("h", "What is still open"),
        ("p", """A shared hostel Wi-Fi puts many anonymous students behind one IP address, so the
        anonymous bucket may be too small on the first day of term, when nobody has signed in yet. I
        have no data on this yet and would like to look at last term's logs before changing it."""),
    ],
])

POSTMORTEM = word([
    ("title", "Postmortem: the lunch-rush outage"),
    ("p", "Written by Rohan Kapoor. Blameless, as agreed. All times are from the application logs."),
    ("h", "Summary"),
    ("p", """On Tuesday the ordering API returned errors for 19 minutes during the lunch rush, from 12:31
    to 12:50. About 640 orders failed, and the canteen took orders on paper until service came back. The
    cause was the database connection pool running out, not the database itself."""),
    ("h", "Timeline"),
    ("p", """12:25: traffic begins to climb, as it does every day. 12:31: the first timeouts appear, and
    the error rate passes 5 per cent. 12:34: the alert fires and Rohan is paged. 12:41: restarting one
    instance helps for about ninety seconds, then errors return. 12:46: the pool size is raised from 20
    to 60 and the instances are restarted. 12:50: errors stop."""),
    ("h", "Root cause"),
    ("p", """Each request held a database connection for its whole duration, including the call to the
    payment provider, which took about 800 milliseconds that day instead of its usual 120. Connections
    were therefore held about seven times longer than normal, and the pool of 20 was exhausted. New
    requests then queued for a connection until they timed out. Database CPU never went above 35 per
    cent, which is why the first guess, that the database was overloaded, was wrong."""),
    ("h", "What went well"),
    ("p", """The alert fired within three minutes. The canteen's paper fallback worked, and no payment was
    taken twice, because order placement is already idempotent."""),
    ("h", "What went badly"),
    ("p", """Nobody had a dashboard showing the pool, so twelve minutes went on the wrong theory. Raising
    the pool to 60 fixed the symptom and not the cause."""),
    ("h", "Action items"),
    ("p", """Release the connection before calling the payment provider. Add pool wait time to the main
    dashboard. Alert when pool wait passes 100 milliseconds. Set a two-second timeout on the provider
    call, with one retry."""),
])

CLEANING_REPORT = pdf([
    [
        ("title", "Cleaning the hostel survey dataset"),
        ("p", "Ananya Rao. Report for Meera Iyer."),
        ("h", "The dataset"),
        ("p", """The hostel welfare survey has 4,212 responses collected over three terms through two
        versions of a form. Term one recorded room type as free text; terms two and three used a
        dropdown. Satisfaction is on a scale of 1 to 5, except in term one, where it was 1 to 10."""),
        ("h", "What was wrong with it"),
        ("p", """There were 318 exact duplicates, nearly all from the form being resubmitted when the
        hostel Wi-Fi dropped. Room type had 47 spellings of the same six values. 9 per cent of ages were
        missing, and 22 responses gave an age under 16 or over 60, which the hostels do not admit."""),
    ],
    [
        ("h", "Decisions"),
        ("p", """Duplicates were removed by keeping the earliest response per student per term. Term one's
        satisfaction scores were rescaled to 1 to 5 rather than dropped, because dropping them would have
        removed a third of the data. Impossible ages were set to missing rather than corrected, because
        there is no way to know the real value. Missing ages were left missing: the mean would have hidden
        that they came almost entirely from one hostel."""),
        ("h", "Result"),
        ("p", """The cleaned set has 3,894 responses. The pipeline is a single script that can be re-run
        from the raw export, and every rule logs how many rows it changed. Average satisfaction moved from
        3.9 to 3.4 once term one was rescaled, which matters more than any other change in this report."""),
    ],
])

SCHEMA_NOTE = word([
    ("title", "Star schema for the survey warehouse"),
    ("p", "Ananya Rao."),
    ("h", "The choice"),
    ("p", """One fact table of responses, with dimension tables for hostel, term and room type. I chose a star
    schema over keeping one wide table because the wardens' questions are almost all of the form 'by hostel,
    by term', and each dimension changes rarely."""),
    ("h", "What I gave up"),
    ("p", """Loading is slower, since each load has to look up dimension keys first, and it adds three small tables
    to explain to anyone new. At 3,894 rows the query speed does not matter yet: the argument is clarity."""),
    ("h", "Slowly changing dimensions"),
    ("p", """Hostels get renamed. I keep a row per name with valid-from and valid-to dates, so last year's reports
    still say what they said last year."""),
])


# ---------------------------------------------------------------- calling the app


class Api:
    def __init__(self):
        self.client = httpx.Client(base_url=API, timeout=60)

    def call(self, method: str, path: str, as_user: str, **kwargs):
        res = self.client.request(method, path, headers={"X-Dev-User-Id": as_user}, **kwargs)
        if res.status_code >= 400:
            raise SystemExit(f"{method} {path} answered {res.status_code}: {res.text[:200]}")
        return res.json() if res.content else None

    def post(self, path, as_user, body):
        return self.call("POST", path, as_user, json=body)


def wipe() -> None:
    """Empties the demo databases, and only those. Collections are emptied rather
    than dropped so that the running server keeps its indexes."""
    assert_demo_database(DEMO_DB)
    app = MongoClient(APP_MONGO)[DEMO_DB]
    for name in app.list_collection_names():
        app[name].delete_many({})
    MongoClient(CHUNK_MONGO)[DEMO_DB].knowledge_chunks.delete_many({})


def add_users() -> None:
    now = datetime.now(timezone.utc)
    MongoClient(APP_MONGO)[DEMO_DB].users.insert_many([
        {
            "_id": ObjectId(uid), "firebaseUid": f"demo-{uid}", "email": email, "displayName": name, "photoURL": "",
            "role": role, "isOnline": False, "bio": bio, "expertise": "", "availability": "", "createdAt": now,
        }
        for uid, name, email, role, bio in USERS
    ])


def assignment(api, mid, title, instructions, days=7):
    due = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
    api.post("/api/assignments", MENTOR, {"title": title, "instructions": instructions, "dueAt": due, "mentorshipIds": [mid]})


def hand_in(api, mid, student, title, text="", files=(), review=None):
    """The student attaches and hands in; the mentor reviews: (action, note)."""
    rows = api.call("GET", f"/api/mentorships/{mid}/assignments", student)
    sid = next(r["_id"] for r in rows if r["assignment"]["title"] == title)
    for name, data, kind in files:
        api.call("POST", f"/api/submissions/{sid}/files", student, files={"file": (name, data, kind)})
    api.call("PUT", f"/api/submissions/{sid}", student, json={"text": text, "turnIn": True})
    if review:
        api.call("PATCH", f"/api/submissions/{sid}", MENTOR, json={"action": review[0], "note": review[1]})


def goal(api, mid, title, description, milestones, done=()):
    created = api.post(f"/api/mentorships/{mid}/goals", MENTOR, {"title": title, "description": description, "milestones": milestones})
    for milestone in created["milestones"]:
        if milestone["title"] in done:
            api.call("PATCH", f"/api/goals/{created['_id']}/milestones/{milestone['_id']}", MENTOR, json={"done": True})


def resource(api, mid, title, url, note):
    api.post(f"/api/mentorships/{mid}/resources", MENTOR, {"title": title, "url": url, "note": note})


# ---------------------------------------------------------------- the world


def rohan_git_ended(api) -> str:
    """Finished last term: shows the ended state."""
    mid = api.post("/api/mentorships", MENTOR, {"studentId": ROHAN, "topic": "Git and code review basics"})["_id"]
    assignment(api, mid, "Review a classmate's pull request",
               "Pick a real pull request from your course project and leave at least three review comments. Say what you would change and why.")
    hand_in(api, mid, ROHAN, "Review a classmate's pull request",
            text="I reviewed the menu-caching pull request and left four comments, mostly about a missing test for cache expiry.",
            review=("accept", "Good: your comments explained why, not just what."))
    api.call("PATCH", f"/api/mentorships/{mid}", MENTOR, json={"action": "end", "note": "Covered everything we planned."})
    return mid


def rohan_backend(api) -> str:
    mid = api.post("/api/mentorships", MENTOR, {"studentId": ROHAN, "topic": "Backend engineering for placement interviews"})["_id"]

    assignment(api, mid, "Design rate limiting for the ordering API",
               """Last term one badly behaved client slowed lunch ordering for everyone. Design a rate limiter for the
               canteen ordering API. Say which algorithm you chose and what you rejected, give real numbers, and say what
               happens when the limiter's own storage is down. Measure it under the lunch peak before you hand it in.""")
    hand_in(api, mid, ROHAN, "Design rate limiting for the ordering API",
            text="Design note attached. Token bucket per user in Redis, tested with k6 against the lunch peak.",
            files=[("rate-limiter-design.pdf", RATE_LIMITER, PDF_TYPE)],
            review=("request-changes", """The reasoning on fail-open is good. Two changes: charge by what a request costs the
            database, and check whether a whole hostel behind one IP address will be refused on the first day of term. Pull
            last term's logs for that before you resubmit."""))

    assignment(api, mid, "Write a postmortem for the lunch-rush outage",
               "Write a blameless postmortem for Tuesday's outage: summary, timeline, root cause, what went well and badly, and action items with owners.")
    hand_in(api, mid, ROHAN, "Write a postmortem for the lunch-rush outage",
            text="Postmortem attached.",
            files=[("lunch-rush-postmortem.docx", POSTMORTEM, DOCX_TYPE)],
            review=("accept", """This is the best thing you have written for me. The sentence about database CPU never passing 35 per cent
            is what makes the root cause believable. Next time, put a name beside each action item."""))

    assignment(api, mid, "Make order placement idempotent",
               "A student whose phone retries must not pay twice. Make POST /orders safe to retry, and explain how a duplicate is recognised and how long you remember it.")
    hand_in(api, mid, ROHAN, "Make order placement idempotent",
            text="""The client sends an Idempotency-Key header, a UUID generated once per order attempt. The server stores the key and the
            response in one transaction with the order, for 24 hours. A repeat with the same key gets the stored response, and a repeat with
            the same key and a different body gets a 422.""",
            review=("accept", "Right design. 24 hours is more than the phone will ever retry, which is the correct direction to be wrong in."))

    assignment(api, mid, "Prepare for a mock system design interview",
               """We will do a 45-minute mock interview next Friday: design the canteen's live queue display. Bring your assumptions as
               numbers, and be ready to say what you would cut if you only had a day.""", days=10)

    goal(api, mid, "Be ready for backend interviews by March",
         "Be able to explain and defend real production decisions, with your own numbers, in an interview.",
         ["Explain database connection pooling", "Write a real postmortem", "Design a rate limiter", "Pass a mock system design interview", "Explain consensus at a whiteboard"],
         done=["Explain database connection pooling", "Write a real postmortem"])

    resource(api, mid, "Stripe: Designing robust and predictable APIs with idempotency", "https://stripe.com/blog/idempotency",
             "Read before the idempotency assignment. Pay attention to how long keys are kept.")
    resource(api, mid, "Google SRE book: Postmortem culture", "https://sre.google/sre-book/postmortem-culture/",
             "How to write about an outage without blaming anyone. Read the example at the end.")
    resource(api, mid, "k6 documentation", "https://grafana.com/docs/k6/latest/",
             "For load tests. Start with ramping scenarios, and always watch the load generator's own CPU.")
    return mid


def ananya_data(api) -> str:
    mid = api.post("/api/mentorships", MENTOR, {"studentId": ANANYA, "topic": "Data engineering fundamentals"})["_id"]

    assignment(api, mid, "Clean the hostel survey dataset",
               "Clean the raw export of the hostel welfare survey. Report what was wrong, what you decided and why, and how much each decision changed the results.")
    hand_in(api, mid, ANANYA, "Clean the hostel survey dataset",
            text="Report attached. The pipeline re-runs from the raw export.",
            files=[("survey-cleaning-report.pdf", CLEANING_REPORT, PDF_TYPE)],
            review=("accept", "Rescaling term one instead of dropping it was the key decision, and you showed what it changed. Well done."))

    assignment(api, mid, "Design a warehouse schema for the survey",
               "Propose a schema for the wardens' reporting. Say what you gave up, and how you handle a hostel being renamed.")
    hand_in(api, mid, ANANYA, "Design a warehouse schema for the survey",
            text="Note attached.",
            files=[("survey-star-schema.docx", SCHEMA_NOTE, DOCX_TYPE)],
            review=("request-changes", "Good on slowly changing dimensions. Add one worked query per warden question, so we can see the schema answer them."))

    goal(api, mid, "Move into a data engineering role", "Have two end-to-end pipeline projects you can explain in an interview.",
         ["Clean a messy real dataset", "Design a warehouse schema", "Schedule a pipeline with retries"], done=["Clean a messy real dataset"])
    resource(api, mid, "The Data Warehouse Toolkit (Kimball)", "https://www.kimballgroup.com/data-warehouse-business-intelligence-resources/books/data-warehouse-dw-toolkit/",
             "Chapters 1 and 2 before the schema assignment. Skip the rest for now.")
    return mid


def wait_for_index(api, mid, as_user, title, query, seconds=180) -> None:
    """Until search finds this file. Syncs run in order, so the last file written
    being searchable means everything before it is too."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        res = api.client.post(f"/api/mentorships/{mid}/copilot/search", headers={"X-Dev-User-Id": as_user},
                              json={"query": query, "k": 10})
        if res.status_code == 200 and any(c["title"] == title for c in res.json().get("chunks", [])):
            return
        time.sleep(1)
    raise SystemExit(f"'{title}' did not become searchable in {seconds} s.")


def is_seeded() -> bool:
    assert_demo_database(DEMO_DB)
    return MongoClient(APP_MONGO)[DEMO_DB].mentorships.count_documents({}) >= 3


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--if-empty", action="store_true", help="do nothing if the demo database is already seeded")
    args = parser.parse_args()
    assert_demo_database(DEMO_DB)

    if args.if_empty and is_seeded():
        print(f"Demo data is already in {DEMO_DB}.")
        return

    started = time.perf_counter()
    wipe()
    add_users()
    api = Api()
    # The guard against the wrong server: it only knows these users if it is
    # serving this database, and anything it knows is about to be written to it.
    probe = api.client.get("/api/mentorships", headers={"X-Dev-User-Id": MENTOR})
    if probe.status_code != 200:
        raise SystemExit(
            f"The server at {API} does not know the demo users (it answered {probe.status_code}), so it is not serving "
            f"{DEMO_DB} with ALLOW_DEV_AUTH on. Nothing was written through it."
        )

    ended = rohan_git_ended(api)
    backend = rohan_backend(api)
    data = ananya_data(api)
    wait_for_index(api, backend, ROHAN, "lunch-rush-postmortem.docx", "root cause of the lunch rush outage")
    wait_for_index(api, data, ANANYA, "survey-star-schema.docx", "star schema slowly changing dimensions")
    print(f"Seeded {DEMO_DB} in {time.perf_counter() - started:.1f} s: mentorships {backend} (active), {data} (active), {ended} (ended).")


if __name__ == "__main__":
    main()
