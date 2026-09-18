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

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from config import SERVICE_SECRET
from store import ChunkStore

app = FastAPI(title="MentorConnect retrieval", docs_url=None, redoc_url=None)
store = ChunkStore()


def require_secret(x_ai_secret: str = Header(default="")) -> None:
    # compare_digest rather than ==: the timing of a string comparison leaks
    # how much of the secret was right.
    if not SERVICE_SECRET or not hmac.compare_digest(x_ai_secret, SERVICE_SECRET):
        raise HTTPException(status_code=401, detail="Bad or missing service secret")


class SearchRequest(BaseModel):
    mentorshipId: str
    viewerId: str
    query: str = Field(min_length=1, max_length=1000)
    k: int = Field(default=5, ge=1, le=20)


class Chunk(BaseModel):
    title: str
    content: str
    sourceType: str
    sourceId: str
    chunkIndex: int
    score: float
    url: str | None = None


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/search", dependencies=[Depends(require_secret)])
def search(body: SearchRequest) -> dict:
    hits = store.search(body.mentorshipId, body.viewerId, body.query, body.k)

    # No answer text yet, on purpose: retrieval is the part worth measuring,
    # and an LLM would only obscure whether the right chunks came back.
    return {
        "query": body.query,
        "chunks": [Chunk(**hit).model_dump() for hit in hits],
    }
