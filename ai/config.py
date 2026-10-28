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

# 384 dimensions, CPU-only, ~90 MB. Chosen so ingestion costs nothing and runs
# offline; the evaluation compares it against a larger model later.
EMBEDDING_MODEL = os.getenv("AI_EMBEDDING_MODEL", "all-MiniLM-L6-v2")
EMBEDDING_DIMS = int(os.getenv("AI_EMBEDDING_DIMS", "384"))

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
# is clamped to. all-MiniLM-L6-v2 stops at 256 tokens; bge-small-en-v1.5 reads
# 512 at the same 384 dimensions, which is the whole argument for D1. A test
# asserts this value matches the model rather than trusting the comment.
EMBEDDING_MAX_TOKENS = int(os.getenv("AI_EMBEDDING_MAX_TOKENS", "256"))

# The shared secret Express presents. The service also binds to localhost, so
# this is the second lock rather than the only one.
SERVICE_SECRET = os.getenv("AI_SERVICE_SECRET", "")

HOST = os.getenv("AI_HOST", "127.0.0.1")
PORT = int(os.getenv("AI_PORT", "8000"))
