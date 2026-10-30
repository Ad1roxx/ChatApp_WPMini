"""Settings for the AI service, all overridable by environment.

Defaults point at the Atlas Local container on 27018, never at the development
database on 27017. That is deliberate: this service writes an index derived
from application data, and it should never be one typo away from writing into
the database a person is using.
"""

import os

from dotenv import load_dotenv

load_dotenv()

# The Atlas Local container. $vectorSearch does not exist on a plain community
# server, which is why this is a separate port rather than the app's Mongo.
MONGODB_URI = os.getenv(
    "AI_MONGODB_URI", "mongodb://127.0.0.1:27018/?directConnection=true"
)
DB_NAME = os.getenv("AI_DB_NAME", "chatapp_rag")

CHUNKS_COLLECTION = "knowledge_chunks"
VECTOR_INDEX = "chunk_vector_index"

# 384 dimensions, CPU-only, ~130 MB. Local so that ingestion costs nothing and
# runs offline.
#
# bge-small-en-v1.5 rather than all-MiniLM-L6-v2, the usual default, for one
# concrete reason: MiniLM reads 256 tokens and bge-small reads 512, at the same
# 384 dimensions. That limit is a hard ceiling on chunk size and exceeding it
# raises nothing — the model truncates and embeds the surviving prefix. With a
# 400-token budget, MiniLM would silently discard the back half of every full
# chunk. bge-small also scores better on MTEB retrieval, but the context limit
# is the deciding argument.
#
# The width is unchanged, so the vector index does not need rebuilding when the
# model moves: see the note beside `numDimensions` in store.py.
EMBEDDING_MODEL = os.getenv("AI_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
EMBEDDING_DIMS = int(os.getenv("AI_EMBEDDING_DIMS", "384"))

# BGE models are trained asymmetrically: passages bare, queries prefixed. This
# is the prefix the model was fine-tuned with, so it is a property of the model
# rather than a knob. A model without one leaves it empty.
QUERY_INSTRUCTION = os.getenv(
    "AI_QUERY_INSTRUCTION",
    "Represent this sentence for searching relevant passages: ",
)

# Chunk sizing, in the embedding model's own tokens.
#
# Characters were a proxy for this, and a loose one: the model truncates in
# tokens and does so silently, so a budget measured in anything else is a guess
# that looks correct until a denser document arrives.
CHUNK_BUDGET_TOKENS = int(os.getenv("AI_CHUNK_BUDGET_TOKENS", "400"))
CHUNK_OVERLAP_TOKENS = int(os.getenv("AI_CHUNK_OVERLAP_TOKENS", "60"))

# Below this a chunk is a fragment - a heading remnant, a stray line - and is
# folded into its neighbour rather than indexed as a competitor to it.
MIN_CHUNK_TOKENS = int(os.getenv("AI_MIN_CHUNK_TOKENS", "32"))

# What the configured model can actually read, which is what the chunk budget
# is clamped to. bge-small-en-v1.5 reads 512 tokens, so the 400-token budget
# above is now reachable in full; all-MiniLM-L6-v2 stopped at 256 and clamped
# it to 240. A test asserts this value matches the loaded model rather than
# trusting the comment, so a model switch that forgets it fails loudly.
EMBEDDING_MAX_TOKENS = int(os.getenv("AI_EMBEDDING_MAX_TOKENS", "512"))

# ---------------------------------------------------------------------------
# What the served search does
# ---------------------------------------------------------------------------
# How many chunks a caller gets by default. Four rather than five because from
# S2 these go into a prompt: every extra chunk is both more context and more
# chance of a distractor, and D7 settled on four.
SERVED_K = int(os.getenv("AI_SERVED_K", "4"))

# How many the index is asked for before reranking. The bi-encoder is good at
# getting the right passage somewhere into a top-30 and unreliable about the
# exact order, so it is used to narrow rather than to rank.
CANDIDATE_K = int(os.getenv("AI_CANDIDATE_K", "30"))

# A small cross-encoder trained on MS MARCO relevance judgements. It reads the
# question and the passage TOGETHER, so every token of one can attend to the
# other - far more accurate than two separate vectors, and impossible to
# precompute, which is why it only ever sees the candidates.
RERANK_MODEL = os.getenv("AI_RERANK_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
# OFF by default since the end of S1 (BUILD_NOTES Entry 52). Re-measured on a
# corpus with documents in it, as D7 required, it was a mixed result: +0.03
# recall@1 on the record questions, -0.06 on the document questions, and about
# 370 ms added to every search. And the measurement could not test the
# two-stage design it exists for: the evaluated student sees 25 chunks against
# a 30-candidate pool, so it only ever re-sorted the whole mentorship. S2
# revisits it on a corpus larger than the pool. AI_RERANK=1 turns it back on.
RERANK = os.getenv("AI_RERANK", "0") == "1"

# Diversity: at most this many chunks from one record, and the relevance gap
# below which that cap is allowed to displace a more relevant chunk. A blind
# cap costs precision on questions one document genuinely owns; the margin
# makes diversity the tie-breaker rather than a quota.
DIVERSITY = os.getenv("AI_DIVERSITY", "soft_cap")
DIVERSITY_CAP = int(os.getenv("AI_DIVERSITY_CAP", "3"))
DIVERSITY_MARGIN = float(os.getenv("AI_DIVERSITY_MARGIN", "0.2"))

# The shared secret Express presents. The service also binds to localhost, so
# this is the second lock rather than the only one.
SERVICE_SECRET = os.getenv("AI_SERVICE_SECRET", "")

HOST = os.getenv("AI_HOST", "127.0.0.1")
PORT = int(os.getenv("AI_PORT", "8000"))
