"""Make the index agree with one record, as it is now.

S1.5 step 3. Express tells this service *which* record changed - an id, never
its content - and the sync reads the record itself and makes the index match.

## Sync, not deltas

There is no "add" and no "delete" here. Every sync asks the same question - what
should the index hold for this source now? - and replaces whatever is there
with the answer. That makes it idempotent, and it makes the ORDER of events
irrelevant: an upload's event and its deletion's event arriving the wrong way
round both resolve to the record's current state, which has no file. A delta
design would have to get the order right; this one cannot get it wrong.

It also means Express - or anything else that reaches the endpoint - can never
put text or viewers into the index. It can only say "look at this record". What
gets indexed, and who may see it, is decided here, from the app's database, by
the same rules as a full re-index (`sources.py`).

## One at a time

Every sync in this process takes one lock. The sync worker is a single thread
anyway; the lock is for everything else that might call these functions - the
start-up catch-up, a test running two at once - because replacing a source is
delete-then-insert, and two of those interleaved would leave both sets of
chunks behind. Across processes (the `ingest.py` CLI running while the service
is), a unique index on `(mentorshipId, sourceType, sourceId, chunkIndex)` makes
a second copy impossible: the loser's insert fails rather than duplicating.
"""

from __future__ import annotations

import logging
import queue
import threading

import sources
from chunking import chunk_document
from ingest import run as full_run

log = logging.getLogger(__name__)

_lock = threading.Lock()


def _replace(store, documents: list[dict], budget=None) -> tuple[set, int]:
    seen, written = set(), 0
    for doc in documents:
        written += store.replace_source(doc, chunk_document(doc, budget=budget))
        seen.add((doc["mentorship_id"], doc["source_type"], doc["source_id"]))
    return seen, written


def _remove_unless_seen(store, query: dict, seen: set) -> int:
    """Delete the chunks matching `query` whose source this sync did not produce."""
    stale = [
        c["_id"]
        for c in store.chunks.find(query, {"mentorshipId": 1, "sourceType": 1, "sourceId": 1})
        if (c["mentorshipId"], c["sourceType"], c["sourceId"]) not in seen
    ]
    return store.chunks.delete_many({"_id": {"$in": stale}}).deleted_count if stale else 0


def _sync_one(store, records, source_type: str, source_id: str, budget=None) -> tuple[int, int]:
    documents = sources.source_documents(records, source_type, source_id)
    seen, written = _replace(store, documents, budget)

    # Whatever this source contributed before and no longer does: its text in
    # a mentorship it has left, or a file no longer on the record.
    removed = _remove_unless_seen(
        store,
        {
            "$or": [
                {"sourceType": source_type, "sourceId": source_id},
                {"sourceType": "attachment", "parentType": source_type, "parentId": source_id},
            ]
        },
        seen,
    )
    return written, removed


def sync_source(store, records, source_type: str, source_id: str, budget=None) -> dict:
    """Make the index match one record. Returns what changed, for the log."""
    if source_type not in sources.SOURCE_TYPES:
        raise ValueError(f"unknown source type {source_type!r}")

    with _lock:
        written, removed = _sync_one(store, records, source_type, source_id, budget)

        if source_type == "assignment":
            # A hand-in's title and version come from its assignment, so they
            # are synced with it. And if the assignment is gone, so are its
            # hand-ins - the route deletes them together - so anything still
            # indexed under it is looked for by the id every hand-in chunk and
            # file chunk carries.
            hand_ins = {str(s["_id"]) for s in records.submissions.find({"assignment": sources._oid(source_id)})}
            orphaned = set(store.chunks.distinct("parentId", {"assignmentId": source_id})) | set(
                store.chunks.distinct("sourceId", {"assignmentId": source_id, "sourceType": "submission"})
            )
            for submission_id in hand_ins | orphaned:
                w, r = _sync_one(store, records, "submission", submission_id, budget)
                written, removed = written + w, removed + r

    log.info("synced %s %s: %d chunks written, %d removed", source_type, source_id, written, removed)
    return {"written": written, "removed": removed}


def sync_mentorship(store, records, mentorship_id: str, budget=None) -> dict:
    """Make the index match everything in one mentorship.

    For a change to the mentorship itself - ended, opted out of, accepted. An
    ended mentorship yields nothing to index, so the scoped reconciliation from
    S1 removes everything it held.
    """
    with _lock:
        _, written, removed = full_run(store, records, mentorship_id, budget)
    log.info("synced mentorship %s: %d chunks written, %d removed", mentorship_id, written, removed)
    return {"written": written, "removed": removed}


def sync_everything(store, records, budget=None) -> dict:
    """The full re-index and reconciliation: the start-up catch-up."""
    with _lock:
        _, written, removed = full_run(store, records, None, budget)
    log.info("catch-up: %d chunks written, %d removed", written, removed)
    return {"written": written, "removed": removed}


# --------------------------------------------------------------------------
# The worker
# --------------------------------------------------------------------------
class SyncWorker:
    """One background thread, draining a queue of syncs.

    Off the request path, because extracting and embedding a 10 MB PDF takes
    seconds and Express should not wait for it - nor for a sync at all: its
    call returns as soon as the job is queued.

    One thread rather than a pool: syncs are serialised by the lock anyway, a
    pool would only add threads waiting on it, and one is easy to reason about.
    A job already waiting is not queued twice - ten events for one hand-in
    while it waits become one sync, which still reads the latest state. A job
    that is *running* is queued again, because the record may have changed
    after it read it.

    In-process and in-memory: a restart loses the queue. That is acceptable
    only because of the read-time check, which keeps a lost sync from ever
    exposing a removal, and the start-up catch-up, which re-adds whatever a
    lost sync would have.
    """

    def __init__(self, store, records):
        self.store = store
        self.records = records
        self._queue: queue.Queue = queue.Queue()
        self._pending: set = set()
        self._pending_lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def submit(self, job: tuple) -> bool:
        """Queue a job. False if an identical one is already waiting."""
        with self._pending_lock:
            if job in self._pending:
                return False
            self._pending.add(job)
        self._queue.put(job)
        return True

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="index-sync", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._queue.put(None)
        if self._thread:
            self._thread.join(timeout=30)

    def wait_until_idle(self) -> None:
        """Block until every queued job has run. For tests and the freshness check."""
        self._queue.join()

    def _loop(self) -> None:
        while True:
            job = self._queue.get()
            try:
                if job is None:
                    return
                with self._pending_lock:
                    self._pending.discard(job)
                self._run(job)
            except Exception:  # noqa: BLE001 - one bad job must not stop the worker
                log.exception("sync %s failed; the read-time check keeps search correct meanwhile", job)
            finally:
                self._queue.task_done()

    def _run(self, job: tuple) -> None:
        kind = job[0]
        if kind == "source":
            sync_source(self.store, self.records, job[1], job[2])
        elif kind == "mentorship":
            sync_mentorship(self.store, self.records, job[1])
        elif kind == "everything":
            sync_everything(self.store, self.records)
        else:
            raise ValueError(f"unknown job {job!r}")
