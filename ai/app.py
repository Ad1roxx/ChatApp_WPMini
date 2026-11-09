"""The retrieval service, and since S2 the answering one.

Express is the only thing that talks to this. It verifies the Firebase token,
checks that the caller is actually in the mentorship, and then asks here for
chunks (`/search`) or an answer (`/ask`). This service therefore trusts the
`mentorshipId`, `viewerId` and `role` it is given — which is exactly why it must not be reachable from anywhere else:

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
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from answer import PROMPT_VERSION, answer
import config
from config import APP_DB_NAME, ASK_BUDGET_S, CATCHUP, RERANK, SERVED_K, SERVICE_SECRET, agent_database_problem
from providers import FAILED, NOT_CONFIGURED, PLAIN, RATE_LIMITED, TRUNCATED, UNAVAILABLE, build_provider
from store import ChunkStore, embed_query, reranker
from sync import SyncWorker

# Every chunk the read-time check drops is logged with its reason, at INFO. Python's
# default level is WARNING, and uvicorn configures only its own loggers, so
# without this those lines - the explanation for any answer that came back
# shorter than expected - would be discarded.
logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
for _name in ("store", "sources", "extract", "sync", "copilot.llm", "copilot.answer"):
    logging.getLogger(_name).setLevel(logging.INFO)

store = ChunkStore()
worker: SyncWorker | None = None
# Built once, here, with its HTTP client: the key goes into that client's
# headers and nowhere else. A missing key builds a provider that answers every
# call "not configured", so /ask is a 503 and /search carries on.
provider = build_provider()


@asynccontextmanager
async def lifespan(_app):
    """Start the sync worker, and catch up on anything missed while down.

    The catch-up is a full re-index and reconciliation, queued as the worker's
    first job. Searches run meanwhile, and are correct meanwhile: the read-time
    check does not depend on the index being current, only on the records.
    """
    global worker
    config.require_env_file(config.ENV_FILE)  # before anything else: a clear sentence, not a 401 later
    store.ensure_vector_index()
    # Load the models before taking a request, not on the first one. Lazily,
    # the first search after start-up waited behind the load and the catch-up's
    # embedding, and ran past Express's 15-second timeout (check_freshness.py).
    embed_query("warm-up")
    if RERANK:
        reranker()
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


class AskRequest(BaseModel):
    """Who is asking, where, in what role, the question, and the two parties' names.

    `role` is the asker's position in THIS mentorship, which Express reads from
    the mentorship record after its membership check - never from the user's
    account, the request body or the question. Extra fields are refused, so a
    caller cannot pass chunks, a prompt or a provider choice through.
    """

    model_config = ConfigDict(extra="forbid")
    mentorshipId: str = Field(pattern=_OBJECT_ID)
    viewerId: str = Field(pattern=_OBJECT_ID)
    role: Literal["student", "mentor"]
    question: str = Field(min_length=1, max_length=1000)
    # The two parties' display names, read by Express from the mentorship's record.
    mentorName: str = Field(default="", max_length=200)
    studentName: str = Field(default="", max_length=200)


# The app database `/ask` and `/agent` read records from: a module attribute, so a
# test can set it without touching any database.
AGENT_APP_DB = APP_DB_NAME


def database_problem() -> str | None:
    """Why neither route may run on these databases, for the log; None if they may."""
    return agent_database_problem(AGENT_APP_DB, getattr(getattr(store, "db", None), "name", ""))


# A provider problem, as Express should pass it on. The body carries the
# provider layer's plain sentence, which is all the user ever sees of it.
ASK_STATUS = {
    RATE_LIMITED: 429,
    NOT_CONFIGURED: 503,
    UNAVAILABLE: 503,
    TRUNCATED: 502,
    FAILED: 502,
}


@app.post("/ask", dependencies=[Depends(require_secret), Depends(require_localhost)])
def ask(body: AskRequest) -> JSONResponse:
    """Answer from this turn's search, with verified citations, or abstain.

    200 for an answer and for an abstention - both are the system working.
    429, 502 or 503 for a provider problem, with the plain message. 502 if
    search itself fails (the app's database is unreachable for the read-time
    check): nothing is answered from chunks nobody checked.
    """
    log = logging.getLogger("copilot.answer")
    problem = database_problem()
    if problem:
        log.warning("ask refused: %s", problem)
        return JSONResponse(
            status_code=503,
            content={"status": "error", "message": "The Copilot is not configured on this server",
                     "promptVersion": PROMPT_VERSION},
        )
    try:
        result = answer(
            store, body.mentorshipId, body.viewerId, body.question, provider,
            role=body.role, budget_s=ASK_BUDGET_S,
            parties={"mentor": body.mentorName, "student": body.studentName},
        )
    except Exception as error:  # search failed; the provider layer never raises
        log.error("copilot prompt=%s search failed: %s", PROMPT_VERSION, type(error).__name__)
        return JSONResponse(
            status_code=502,
            content={"status": "error", "message": PLAIN[FAILED], "promptVersion": PROMPT_VERSION},
        )
    status = ASK_STATUS.get(result["outcome"], 200) if result["status"] == "error" else 200
    return JSONResponse(status_code=status, content=result)


# ---------------------------------------------------------------------------
# The agent (S4 Step 5)
# ---------------------------------------------------------------------------
# What the user reads when the agent may not run here. One sentence, the same
# whatever the reason: which database is configured is not theirs to learn.
AGENT_NOT_CONFIGURED = "The agent is not configured on this server."


_THREAD_ID = r"^[0-9a-f]{32}$"


class AgentRequest(BaseModel):
    """One agent turn: who is asking, where, in what role, the question, and the turn's token.

    As for `/ask`, `role` comes from the mentorship record, read by Express after
    its membership check. `token` is the capability token Express minted for this
    turn alone; it is passed to Express's tool endpoint and nowhere else, and is
    never logged. Extra fields are refused.
    """

    model_config = ConfigDict(extra="forbid")
    mentorshipId: str = Field(pattern=_OBJECT_ID)
    viewerId: str = Field(pattern=_OBJECT_ID)
    role: Literal["student", "mentor"]
    question: str = Field(min_length=1, max_length=1000)
    token: str = Field(min_length=20, max_length=4096, repr=False)
    mentorName: str = Field(default="", max_length=200)
    studentName: str = Field(default="", max_length=200)
    threadId: str | None = Field(default=None, pattern=_THREAD_ID)


class PausedRequest(BaseModel):
    """Which paused turn. Extra fields are refused."""

    model_config = ConfigDict(extra="forbid")
    threadId: str = Field(pattern=_THREAD_ID)


class ResumeRequest(PausedRequest):
    """End a paused turn. `decision` is which of two things the person did, never what happened."""

    decision: Literal["approved", "dismissed"]


@app.post("/agent", dependencies=[Depends(require_secret), Depends(require_localhost)])
def agent_turn(body: AgentRequest) -> JSONResponse:
    """One agent turn, through `agent.run_turn`.

    503 "not configured" unless the app database and the index are both
    synthetic (config.AGENT_SYNTHETIC_DATABASES), checked before anything is
    read, searched or sent; and if tracing would send the turn to a third party
    (agent.py refuses to import). Otherwise 200 for every turn that ran,
    answered, abstained, stopped by a cap or refused by Express, and the provider
    layer's status for a provider problem, as for `/ask`.
    """
    log = logging.getLogger("copilot.agent")
    problem = database_problem()
    if problem:
        log.warning("agent refused: %s", problem)
        return JSONResponse(status_code=503, content={"status": "error", "message": AGENT_NOT_CONFIGURED})
    try:
        import agent  # refuses to import while tracing is switched on
    except RuntimeError as error:
        log.warning("agent refused: %s", error)
        return JSONResponse(status_code=503, content={"status": "error", "message": AGENT_NOT_CONFIGURED})

    result = agent.run_turn(agent.Turn(
        mentorship_id=body.mentorshipId, viewer_id=body.viewerId, role=body.role,
        question=body.question, token=body.token, provider=provider, store=store,
        parties={"mentor": body.mentorName, "student": body.studentName}, thread_id=body.threadId,
    ))
    status = ASK_STATUS.get(result.get("outcome"), 502) if result["status"] == "error" else 200
    return JSONResponse(status_code=status, content=result)


def _paused_turns():
    """The agent module, or None if the agent may not run here. As for `/agent`."""
    if database_problem():
        return None
    try:
        import agent
    except RuntimeError:
        return None
    return agent


@app.post("/agent/paused", dependencies=[Depends(require_secret), Depends(require_localhost)])
def agent_paused(body: PausedRequest) -> JSONResponse:
    """Whether this turn is still waiting for a person. Reads only."""
    agent = _paused_turns()
    if agent is None:
        return JSONResponse(status_code=503, content={"status": "error", "message": AGENT_NOT_CONFIGURED})
    return JSONResponse(content={"paused": agent.is_paused(body.threadId)})


@app.post("/agent/resume", dependencies=[Depends(require_secret), Depends(require_localhost)])
def agent_resume(body: ResumeRequest) -> JSONResponse:
    """End a paused turn, at most once. `closed`, or `expired` if it is not waiting any more."""
    agent = _paused_turns()
    if agent is None:
        return JSONResponse(status_code=503, content={"status": "error", "message": AGENT_NOT_CONFIGURED})
    return JSONResponse(content=agent.resume_turn(body.threadId, body.decision))
