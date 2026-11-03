"""The denial checker, old against new, on every cached reply. No calls.

    cd ai && .venv/Scripts/python.exe eval/denial_replay.py

BUILD_NOTES Entry 83. Every reply in the v2, v3 and v4 caches: the answer for a shown
one, the model's raw text for an abstention. A reply that wrote the abstain marker is
counted but cannot change, because the marker is checked before this rule. Lists every
sentence and every reply whose classification changes, for reading by hand.

Writes `eval/denial-checker-replay.txt`.
"""

from __future__ import annotations

import glob
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from answer import _DENIAL, _HANDLES, ABSTAIN_MARKER, is_denial, only_denials, sentences  # noqa: E402

CACHE = HERE / ".answers-cache"
OUT = HERE / "denial-checker-replay.txt"


def old_is_denial(sentence: str) -> bool:
    """The checker as it stood: an opening that denies decides, whatever follows."""
    return bool(_DENIAL.search(_HANDLES.sub("", sentence).strip()))


def old_only_denials(text: str) -> bool:
    found = sentences(text)
    return bool(found) and all(old_is_denial(s) for s in found)


def main() -> None:
    files = sorted(glob.glob(str(CACHE / "s2-v[234]--*.jsonl")))
    replies = marker = denial_sentences = 0
    per_file, changed_sentences, changed_replies = [], [], []
    for path in files:
        name = Path(path).name.replace("--gemini--gemini-3.5-flash-lite", "").removesuffix(".jsonl")
        count = 0
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            result = entry["result"]
            text = result.get("answer") or entry.get("raw") or ""
            count += 1
            if ABSTAIN_MARKER in text:
                marker += 1
                continue
            for sentence in sentences(text):
                old, new = old_is_denial(sentence), is_denial(sentence)
                denial_sentences += old
                if old != new:
                    changed_sentences.append((name, entry["id"], result["status"], old, new, sentence))
            if old_only_denials(text) != only_denials(text):
                changed_replies.append((name, entry["id"], result["status"], result.get("cause"), old_only_denials(text), only_denials(text), text))
        replies += count
        per_file.append(f"  {name:<24} {count} replies")

    out = ["The denial checker, old against new, on every cached reply - BUILD_NOTES Entry 83. No calls.", ""]
    out += per_file
    out += ["", f"  replies {replies}; with the abstain marker {marker}; sentences the old checker called denials {denial_sentences}",
            f"  sentences whose classification changes: {len(changed_sentences)}",
            f"  replies whose classification changes: {len(changed_replies)}", "", "== every sentence that changes"]
    for name, qid, status, old, new, sentence in changed_sentences:
        out += [f"  {name} {qid} (shown as {status}): denial {old} -> {new}", f"    {sentence}"]
    out += ["", "== every whole reply that changes (only denials, old -> new)"]
    for name, qid, status, cause, old, new, text in changed_replies:
        out += [f"  {name} {qid} (was {status} {cause or ''}): {old} -> {new}", f"    {' '.join(text.split())}"]
    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
