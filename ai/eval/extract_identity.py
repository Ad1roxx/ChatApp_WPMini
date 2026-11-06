"""Does a change to extraction leave every chunk's text exactly as it was?

    cd ai
    .venv/Scripts/python.exe eval/extract_identity.py --capture   # before the change; committed
    .venv/Scripts/python.exe eval/extract_identity.py             # after it

S4 Step 4 (BUILD_NOTES Entry 96). Extraction starts counting what it could not
read - pages with no text, dropped blocks, images, tables - so the agent can say
so. Those counts are stored beside the chunks; the text, headings and pages a
chunk is built from must not move by a byte, or search could rank differently.

Every database that holds records the index is built from is walked through the
real pipeline, `sources.documents()` then `chunking.chunk_document()`, read-only.
For each source the script keeps a SHA-256 of what chunking produced (text,
heading, section index, pages) and of the document's sections. Nothing is
embedded and no provider is called.

`--capture` refuses to overwrite the reference.

The reference is in two files. `chatapp` holds real people's records, and its
record ids are keys here, so its part is written to `extract-identity.local.json`,
which git ignores (Entry 97); the rest is committed. A check reads both, and
fails if the local part is missing rather than quietly checking less.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import appdb  # noqa: E402
from chunking import chunk_document  # noqa: E402
from config import APP_MONGODB_URI, CHUNK_BUDGET_TOKENS, MONGODB_URI  # noqa: E402
from sources import documents  # noqa: E402

REFERENCE = HERE / "extract-identity.json"
LOCAL_REFERENCE = HERE / "extract-identity.local.json"
# Real records: their part of the reference never goes into git.
LOCAL_ONLY = ("chatapp",)
# Where records live: the served app and the demo on the app's server; the
# evaluation fixtures beside their own indexes.
DATABASES = (
    (APP_MONGODB_URI, "chatapp"),
    (APP_MONGODB_URI, "chatapp_demo"),
    (MONGODB_URI, "chatapp_eval"),
    (MONGODB_URI, "chatapp_demo_eval"),
)


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def snapshot() -> dict:
    out: dict = {}
    for uri, name in DATABASES:
        records = appdb.connect(uri, name)
        sources = {}
        for doc in documents(records):
            pieces = chunk_document(doc, budget=CHUNK_BUDGET_TOKENS)
            key = f"{doc['source_type']}:{doc['source_id']}"
            sources[key] = {
                "chunks": digest(pieces),
                "sections": digest(doc.get("sections")),
                "count": len(pieces),
                "file": doc.get("sections") is not None,
            }
        out[name] = sources
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", action="store_true")
    args = parser.parse_args()
    now = snapshot()
    if args.capture:
        for path in (REFERENCE, LOCAL_REFERENCE):
            if path.exists():
                raise SystemExit(f"{path.name} exists and is not rewritten")
        about = ("BUILD_NOTES Entry 96: what chunking produced from every source before extraction counted "
                 "unread content. SHA-256 of the chunk dicts and of the sections, per source.")
        for path, part in ((REFERENCE, {k: v for k, v in now.items() if k not in LOCAL_ONLY}),
                           (LOCAL_REFERENCE, {k: v for k, v in now.items() if k in LOCAL_ONLY})):
            path.write_text(json.dumps({"about": about, "databases": part}, indent=1, sort_keys=True), encoding="utf-8")
        for name, sources in now.items():
            files = sum(1 for s in sources.values() if s["file"])
            print(f"captured {name}: {len(sources)} sources, {files} files, {sum(s['count'] for s in sources.values())} chunks")
        return

    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))["databases"]
    failed = False
    if LOCAL_REFERENCE.exists():
        reference.update(json.loads(LOCAL_REFERENCE.read_text(encoding="utf-8"))["databases"])
    else:
        print(f"{', '.join(LOCAL_ONLY)}: no {LOCAL_REFERENCE.name} on this machine, so not checked")
        failed = True
    for name, sources in reference.items():
        current = now.get(name, {})
        differ = sorted(k for k in sources if current.get(k) != sources[k])
        extra = sorted(set(current) - set(sources))
        files = sum(1 for s in sources.values() if s["file"])
        chunks = sum(s["count"] for s in sources.values())
        print(f"{name}: {len(sources) - len(differ)}/{len(sources)} sources identical "
              f"({files} files, {chunks} chunks)" + (f"; differ: {differ}" if differ else "")
              + (f"; new since capture: {extra}" if extra else ""))
        failed |= bool(differ or extra)
    print("IDENTICAL" if not failed else "NOT IDENTICAL")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
