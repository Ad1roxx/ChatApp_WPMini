"""Settings for the AI service, all overridable by environment.

Three databases, with three different jobs:

- **The app's database** (27017, `chatapp`) holds the records people write. This
  service READS it, through `appdb.py`, and never writes to it.
- **The chunk store** (27018, `chatapp_rag`) holds the served index. Only this
  service writes it.
- **The evaluation fixture** (27018, `chatapp_eval`) holds a seeded corpus AND
  its own index, so measuring retrieval never touches either of the above.

Before S1.5 the first and second were the same seeded copy, which is why the
Copilot had never searched anything a real user wrote.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# The keys and the service secret live outside the repository, in the file this
# variable names: other tools work in the repository folder and can read any
# file in it (BUILD_NOTES Entry 102). `ai/.env` holds only settings that are not
# secret, and the key scan fails if a secret appears in it.
ENV_FILE_VAR = "AI_ENV_FILE"


def load_env_file(env=os.environ) -> Path | None:
    """Load the secrets file named by AI_ENV_FILE. Returns its path, or None if unset.

    Set but missing is always an error: someone meant to use it. Unset is an error
    for the running service (`require_env_file`), not for importing this module,
    which every test and tool does.
    """
    value = env.get(ENV_FILE_VAR, "").strip()
    if not value:
        return None
    path = Path(value).expanduser()
    if not path.is_file():
        raise SystemExit(
            f"{ENV_FILE_VAR} is set to {value}, but there is no file there. "
            "Create it with GEMINI_API_KEY, GROQ_API_KEY and AI_SERVICE_SECRET, or correct the setting."
        )
    load_dotenv(path)
    return path


def require_env_file(path: Path | None) -> None:
    """Stop the service with a clear sentence if it has no secrets file."""
    if path is None:
        raise RuntimeError(
            f"{ENV_FILE_VAR} is not set. Set it to the file outside the repository that holds "
            "GEMINI_API_KEY, GROQ_API_KEY and AI_SERVICE_SECRET, for example "
            "%USERPROFILE%\\.mentorconnect\\ai.env. See ai/.env.example."
        )


# Neither call overrides what the environment already sets, so the order is:
# the environment, then the secrets file, then `ai/.env`.
ENV_FILE = load_env_file()
load_dotenv()

# The chunk store: the Atlas Local container. $vectorSearch does not exist on a
# plain community server, which is why the index lives here and not beside the
# app's records.
MONGODB_URI = os.getenv(
    "AI_MONGODB_URI", "mongodb://127.0.0.1:27018/?directConnection=true"
)
DB_NAME = os.getenv("AI_DB_NAME", "chatapp_rag")

# The app's database: where the records and their attachments actually live.
# Read through appdb.py only, which offers no way to write.
APP_MONGODB_URI = os.getenv(
    "AI_APP_MONGODB_URI", "mongodb://127.0.0.1:27017/?directConnection=true"
)
APP_DB_NAME = os.getenv("AI_APP_DB_NAME", "chatapp")

# The evaluation fixture, on the chunk-store server: seeded records and their
# own index in one database. evaluate.py and check_retrieval.py rebuild an
# index from scratch every run, and S1's review found that doing so in the
# served collection is how a MiniLM run left the service answering at random.
EVAL_DB_NAME = os.getenv("AI_EVAL_DB_NAME", "chatapp_eval")

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

# Whether a section's heading is read with its chunk, by the embedder and the
# reranker (BUILD_NOTES Entry 81). Changing it needs the index rebuilt.
EMBED_HEADINGS = os.getenv("AI_EMBED_HEADINGS", "0") == "1"

# A contextual header on every chunk, names as roles in the query, and the
# opening fragment folded. Adopted on measurement (BUILD_NOTES Entries 85-90).
# Changing it needs the index rebuilt: nothing else notices vectors built the other way.
CONTEXT_HEADERS = os.getenv("AI_CONTEXT_HEADERS", "1") == "1"

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
# ON by default since BUILD_NOTES Entry 73 (D7). On a corpus larger than the
# candidate pool it is the most accurate configuration measured - 64 of 83
# answerable questions first, against 56 - and what kept it off, about 1.3 s a
# search, was the batch size rather than the model (below). AI_RERANK=0 turns
# it off.
RERANK = os.getenv("AI_RERANK", "1") == "1"
# How many pairs the cross-encoder scores at once. A batch is padded to its
# longest passage, so the library's default of 32 padded all thirty candidates
# to the longest of them. At 4 the median search is about 440 ms instead of 1.3 s
# on the development machine (8 threads), with the order of all candidates
# identical on all 120 evaluation questions (eval/s2-reranker-speed.txt). It needs
# CPU: 811 ms on 4 threads, 1,148 ms on 2, so re-measure on a smaller host.
RERANK_BATCH_SIZE = int(os.getenv("AI_RERANK_BATCH_SIZE", "4"))

# Diversity: at most this many chunks from one record, and the relevance gap
# below which that cap is allowed to displace a more relevant chunk. A blind
# cap costs precision on questions one document genuinely owns; the margin
# makes diversity the tie-breaker rather than a quota.
DIVERSITY = os.getenv("AI_DIVERSITY", "soft_cap")
DIVERSITY_CAP = int(os.getenv("AI_DIVERSITY_CAP", "3"))
DIVERSITY_MARGIN = float(os.getenv("AI_DIVERSITY_MARGIN", "0.2"))

# What the service does when it starts: "full" re-indexes everything and
# reconciles, catching up on any change whose sync was lost while it was down;
# "off" skips it. Full costs one embedding pass over the app's content, which is
# nothing at this scale and would want revisiting at a real one.
CATCHUP = os.getenv("AI_CATCHUP", "full")

# The shared secret Express presents. The service also binds to localhost, so
# this is the second lock rather than the only one.
SERVICE_SECRET = os.getenv("AI_SERVICE_SECRET", "")

HOST = os.getenv("AI_HOST", "127.0.0.1")
PORT = int(os.getenv("AI_PORT", "8000"))


# ---------------------------------------------------------------------------
# Generation (S2): which model answers, and the limits it answers under
# ---------------------------------------------------------------------------
# AGENT_PLAN 2.6, read 2026-10-31. Gemini generates; Groq is the documented
# fallback, chosen here rather than tried automatically after a failure - an
# automatic fallback would send the same student's material to a second
# provider without anyone deciding it should.
LLM_PROVIDER = os.getenv("AI_LLM_PROVIDER", "gemini")

# Pinned by name, never a "-latest" alias: a model that changes under a pinned
# name changes every answer and every evaluation figure with it. A pinned model
# can still be withdrawn (the 2.5 models were), which is a 404 and a plain
# "unavailable" - never a silent switch to something else.
GEMINI_MODEL = os.getenv("AI_GEMINI_MODEL", "gemini-3.5-flash-lite")
GROQ_MODEL = os.getenv("AI_GROQ_MODEL", "openai/gpt-oss-120b")
# gpt-oss is a reasoning model and its reasoning tokens count as output, both
# against the cap below and against Groq's per-minute bucket.
GROQ_REASONING_EFFORT = os.getenv("AI_GROQ_REASONING_EFFORT", "low")

# The output cap. An answer that reaches it is cut off mid-sentence, so it is
# reported as an error, never shown. Groq reserves prompt + this cap from its
# 8K-a-minute bucket before generating, so it is kept tight.
LLM_MAX_OUTPUT_TOKENS = int(os.getenv("AI_LLM_MAX_OUTPUT_TOKENS", "400"))

# Gemini sends no rate-limit headers, so its budget is counted here. Calls are
# recorded in a small file so that the service, the evaluation and a smoke test
# - which all draw on the same project's quota - see each other's calls, and a
# restart does not reset the count.
GEMINI_RPM = int(os.getenv("AI_GEMINI_RPM", "15"))
# 480 rather than the published 500: Google answered real 429s when this count
# stood at 495 (BUILD_NOTES Entry 71), so ours can run a few short of theirs.
GEMINI_RPD = int(os.getenv("AI_GEMINI_RPD", "480"))
LLM_USAGE_FILE = os.getenv(
    "AI_LLM_USAGE_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".llm-usage.json")
)

# The keys. Read once, at start-up, into each provider's client headers, and
# never into a URL, a log line or an error message. A missing key leaves the
# ask route answering 503 while search goes on working.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()

# How long one answer may spend in the provider, retries and waits included.
# Set from measurement (BUILD_NOTES Entry 67): seven live calls before S2's
# step 5 took 0.50-1.10 s, so 8 s is about seven times the slowest, with room
# for one 429 retry whose retry-after is up to 5 s (MIN_CALL_S is 3).
# Express's own timeout for the ask route sits just above this and search,
# which takes about half a second with the reranker on (server/index.js,
# COPILOT_ASK_TIMEOUT_MS). Re-checked against 120 calls in Entries 68 and 73.
ASK_BUDGET_S = float(os.getenv("AI_ASK_BUDGET_S", "8"))

# --- S4: the agent (agent.py; AGENT_PLAN S4, decided at Step 0) ---
# Where Express's internal tool endpoint listens. Loopback only: Express refuses
# any other peer, and the capability token is sent nowhere else.
AGENT_TOOLS_URL = os.getenv("AI_AGENT_TOOLS_URL", "http://127.0.0.1:3001")
# Caps on one turn. Each has a plain sentence when it is reached (agent.STOPPED).
AGENT_MAX_MODEL_CALLS = int(os.getenv("AI_AGENT_MAX_MODEL_CALLS", "4"))
AGENT_MAX_TOOL_CALLS = int(os.getenv("AI_AGENT_MAX_TOOL_CALLS", "3"))
AGENT_MAX_INPUT_TOKENS_CALL = int(os.getenv("AI_AGENT_MAX_INPUT_TOKENS_CALL", "6000"))
AGENT_MAX_INPUT_TOKENS_TURN = int(os.getenv("AI_AGENT_MAX_INPUT_TOKENS_TURN", "12000"))
# Set from measurement (Entry 101): 12 real turns on the demo, median 2.5 s, slowest
# 10.4 s, a whole-file summary of 10 model calls. 30 s is about three times that.
# Express waits 35 s (COPILOT_AGENT_TIMEOUT_MS) and the browser 40 s, so each
# layer answers before the one in front of it gives up.
AGENT_BUDGET_S = float(os.getenv("AI_AGENT_BUDGET_S", "30"))
# Times are shown to the model in this zone, already formatted (Entry 107). A record
# holds UTC, and the service does not know where a viewer is, so this is one fixed
# zone: the one the people using this app are in.
AGENT_TIME_OFFSET_MINUTES = int(os.getenv("AI_AGENT_TIME_OFFSET_MINUTES", "330"))
AGENT_TIME_ZONE_NAME = os.getenv("AI_AGENT_TIME_ZONE_NAME", "IST")
# summarize_attachment (S4 Step 4): at most this many sections, one summary call
# each, then one call to combine them. All of it is one tool call of the turn,
# inside the turn's time budget. A section longer than this many tokens is
# summarised from its beginning, and the summary says so.
AGENT_SUMMARY_MAX_SECTIONS = int(os.getenv("AI_AGENT_SUMMARY_MAX_SECTIONS", "6"))
AGENT_SUMMARY_SECTION_TOKENS = int(os.getenv("AI_AGENT_SUMMARY_SECTION_TOKENS", "1500"))
# How long a paused turn is kept for: a proposal's five minutes (server/lib/agentProposal.js)
# and a little more, so this side never forgets one that Express would still accept.
AGENT_PROPOSAL_WAIT_S = float(os.getenv("AI_AGENT_PROPOSAL_WAIT_S", "330"))

# The agent and the S2 ask route run on synthetic data only (the user, 2026-11-07
# and 2026-11-09; BUILD_NOTES Entries 101, 105).
# `/agent` and `/ask` refuse, as "not configured", unless both the app database it reads
# records from and the index it reads chunks from are on this list: the demo, the
# evaluation fixtures, and the tests' own databases. Never `chatapp` or
# `chatapp_rag`, which hold real people's records. Deliberately not read from the
# environment: putting a real database on it is a change to this decision, made
# in code and reviewed, not a variable someone sets. Express keeps the same list
# (server/lib/agentDatabases.js) and checks its own database too.
AGENT_SYNTHETIC_DATABASES = frozenset({
    "chatapp_demo",
    "chatapp_eval", "chatapp_demo_eval", "chatapp_eval_ctx", "chatapp_agent_eval", "chatapp_asklive",
    "chatapp_test", "chatapp_rag_pytest", "chatapp_rag_pytest_app",
})


def agent_database_problem(app_db: str, index_db: str) -> str | None:
    """Why the agent must not run on these databases, for the log; None if it may."""
    for kind, name in (("app database", app_db), ("index", index_db)):
        if name not in AGENT_SYNTHETIC_DATABASES:
            return f"the {kind} {name!r} is not one of the synthetic databases the agent may run on"
    return None
