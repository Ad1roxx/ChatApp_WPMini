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

# Chunk size in characters rather than tokens: the sources here are short
# enough that the difference does not matter, and characters are something a
# person can reason about when reading the chunks back.
CHUNK_MAX_CHARS = int(os.getenv("AI_CHUNK_MAX_CHARS", "800"))
CHUNK_OVERLAP = int(os.getenv("AI_CHUNK_OVERLAP", "120"))

# The shared secret Express presents. The service also binds to localhost, so
# this is the second lock rather than the only one.
SERVICE_SECRET = os.getenv("AI_SERVICE_SECRET", "")

HOST = os.getenv("AI_HOST", "127.0.0.1")
PORT = int(os.getenv("AI_PORT", "8000"))
