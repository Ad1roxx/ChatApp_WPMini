"""The retrieval service.

Express is the only thing that talks to this. It verifies the Firebase token,
checks that the caller is actually in the mentorship, and then asks here for
chunks. This service therefore trusts the `mentorshipId` and `viewerId` it is
given — which is exactly why it must not be reachable from anywhere else:

- it binds to 127.0.0.1, so nothing off the machine can open a socket to it
- every route requires a shared secret Express holds

Both, not either. The bind is what stops the internet; the secret is what stops
anything else on the same machine. Neither is a substitute for the membership
check Express does first — this service cannot make that check, because it has
no idea who the caller is.
"""

from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager
from typing import Literal, Union

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from config import CATCHUP, SERVED_K, SERVICE_SECRET
from store import ChunkStore
from sync import SyncWorker

# Every chunk the read-time check drops is logged with its reason, at INFO. Python's
# default level is WARNING, and uvicorn configures only its own loggers, so
# without this those lines - the explanation for any answer that came back
# shorter than expected - would be discarded.
logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
for _name in ("store", "sources", "extract", "sync"):
    logging.getLogger(_name).setLevel(logging.INFO)

store = ChunkStore()
worker: SyncWorker | None = None


@asynccontextmanager
async def lifespan(_app):
    """Start the sync worker, and catch up on anything missed while down.

    The catch-up is a full re-index and reconciliation, queued as the worker's
    first job. Searches run meanwhile, and are correct meanwhile: the read-time
    check does not depend on the index being current, only on the records.
    """
    global worker
    store.ensure_vector_index()
    worker = SyncWorker(store, store.records)
    worker.start()
    if CATCHUP == "full":
        worker.submit(("everything",))
    yield
    worker.stop()


app = FastAPI(title="MentorConnect retrieval", docs_url=None, redoc_url=None, lifespan=lifespan)


def require_secret(x_ai_secret: str = Header(default="")) -> None:
    # compare_digest rather than ==: the timing of a string comparison leaks
    # how much of the secret was right.
    if not SERVICE_SECRET or not hmac.compare_digest(x_ai_secret, SERVICE_SECRET):
        raise HTTPException(status_code=401, detail="Bad or missing service secret")


LOCAL_CALLERS = {"127.0.0.1", "::1"}


def require_localhost(request: Request) -> None:
    """Refuse any caller not on this machine.

    The service already binds to 127.0.0.1, so nothing off the machine can
    connect. This is the same rule checked again at the endpoint that can
    change the index, so a later `--host 0.0.0.0` would not quietly open it.
    """
    if request.client is None or request.client.host not in LOCAL_CALLERS:
        raise HTTPException(status_code=403, detail="Local callers only")


class SearchRequest(BaseModel):
    mentorshipId: str
    viewerId: str
    query: str = Field(min_length=1, max_length=1000)
    k: int = Field(default=SERVED_K, ge=1, le=20)


class Chunk(BaseModel):
    title: str
    content: str
    sourceType: str
    sourceId: str
    chunkIndex: int
    score: float
    url: str | None = None

    # Where a chunk came from, so an answer can cite something a person can
    # open. Empty for a record's own text, which has no position inside it.
    parentType: str | None = None
    parentId: str | None = None
    parentTitle: str | None = None
    attachmentId: str | None = None
    fileKind: str | None = None
    heading: str | None = None
    startPage: int | None = None
    endPage: int | None = None


_OBJECT_ID = r"^[0-9a-f]{24}$"


class SourceSync(BaseModel):
    """Which record changed - and nothing else.

    `extra="forbid"` is the security property, not tidiness: a body carrying
    text, viewers or a mentorship is refused, so nothing that reaches this
    endpoint can put content into the index or choose who sees it. The record
    is read here, from the app's database, and its mentorship comes from the
    record - so it cannot be indexed into a different one either.
    """

    model_config = ConfigDict(extra="forbid")
    sourceType: Literal["assignment", "submission", "goal", "resource"]
    sourceId: str = Field(pattern=_OBJECT_ID)


class MentorshipSync(BaseModel):
    """A change to the mentorship itself: ended, opted out of, accepted."""

    model_config = ConfigDict(extra="forbid")
    mentorshipId: str = Field(pattern=_OBJECT_ID)


@app.post(
    "/index/sync",
    status_code=202,
    dependencies=[Depends(require_secret), Depends(require_localhost)],
)
def index_sync(body: Union[SourceSync, MentorshipSync]) -> dict:
    """Queue a sync and answer at once. 202: accepted, not yet done.

    Express does not wait for the sync, and does not retry it: if it is lost,
    the read-time check keeps search correct and the next start-up's catch-up
    puts back anything a lost sync would have added.
    """
    if worker is None:
        raise HTTPException(status_code=503, detail="Sync worker not running")
    job = (
        ("source", body.sourceType, body.sourceId)
        if isinstance(body, SourceSync)
        else ("mentorship", body.mentorshipId)
    )
    return {"queued": worker.submit(job)}


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/search", dependencies=[Depends(require_secret)])
def search(body: SearchRequest) -> dict:
    hits = store.search(body.mentorshipId, body.viewerId, body.query, body.k)

    # No answer text yet, on purpose: retrieval is the part worth measuring,
    # and an LLM would only obscure whether the right chunks came back.
    #
    # `score` is the cross-encoder's logit when reranking is on, not a cosine:
    # a raw, query-relative number that orders these chunks and means nothing
    # compared against another query's. Nothing thresholds on it (Entry 41).
    return {
        "query": body.query,
        "chunks": [Chunk(**hit).model_dump() for hit in hits],
    }
