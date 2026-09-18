"""Turning application data into documents worth retrieving.

Only first-party text is indexed — things a person in the mentorship actually
wrote. Resources are links with a short note, so they contribute a title and a
note rather than the page behind them; fetching arbitrary URLs from the server
would be an SSRF hole for very little retrieval value.

## Who may see a chunk

Every document carries `viewers`: the user ids allowed to retrieve it. Two
shapes:

- **Shared** — an assignment brief, a goal, a resource. Both parties.
- **A student's own** — their hand-in text and the mentor's review of it. The
  student and their mentor, nobody else. A mentorship can have one student, but
  the same brief goes to several, and one student's hand-in is not the others'
  to read.

`viewers` is denormalised from the mentorship on purpose: it makes the filter a
single `$in` inside the vector query. It is the second lock, not the first —
Express checks mentorship membership before this service is ever called.
"""

from __future__ import annotations

from typing import Iterator

from bson import ObjectId


def _ids(value) -> str:
    return str(value)


def _mentorship_map(db, mentorship_id: str | None) -> dict[str, dict]:
    query = {"status": "active"}
    if mentorship_id:
        query["_id"] = ObjectId(mentorship_id)
    return {_ids(m["_id"]): m for m in db.mentorships.find(query)}


def documents(db, mentorship_id: str | None = None) -> Iterator[dict]:
    """Yield one document per piece of text worth indexing."""
    mentorships = _mentorship_map(db, mentorship_id)
    if not mentorships:
        return

    oids = [ObjectId(mid) for mid in mentorships]

    def parties(mid: str) -> list[str]:
        m = mentorships[mid]
        return [_ids(m["student"]), _ids(m["mentor"])]

    # ---- Assignment briefs: shared by everyone the work was set for ----
    for a in db.assignments.find({"mentorships": {"$in": oids}}):
        body = "\n\n".join(filter(None, [a.get("title", ""), a.get("instructions", "")]))
        for mid_obj in a.get("mentorships", []):
            mid = _ids(mid_obj)
            if mid not in mentorships:
                continue
            yield {
                "mentorship_id": mid,
                "source_type": "assignment",
                "source_id": _ids(a["_id"]),
                "title": a.get("title", "Assignment"),
                "text": body,
                "viewers": parties(mid),
                "visibility": "mentorship",
                "owner_id": None,
                "due_at": a.get("dueAt"),
            }

    # ---- Hand-ins and the reviews of them: the student's, and their mentor's ----
    for s in db.submissions.find({"mentorship": {"$in": oids}}):
        mid = _ids(s["mentorship"])
        if mid not in mentorships:
            continue

        review = (s.get("review") or {}).get("note", "")
        body = "\n\n".join(
            filter(None, [s.get("text", ""), f"Mentor's review: {review}" if review else ""])
        )
        if not body.strip():
            continue

        assignment = db.assignments.find_one({"_id": s["assignment"]}) or {}
        yield {
            "mentorship_id": mid,
            "source_type": "submission",
            "source_id": _ids(s["_id"]),
            "title": f"Hand-in: {assignment.get('title', 'assignment')}",
            "text": body,
            "viewers": parties(mid),
            "visibility": "student",
            "owner_id": _ids(s["student"]),
        }

    # ---- Goals, with their milestones as the body ----
    for g in db.goals.find({"mentorship": {"$in": oids}}):
        mid = _ids(g["mentorship"])
        if mid not in mentorships:
            continue

        milestones = "\n".join(
            f"- {m.get('title', '')}" + (" (done)" if m.get("done") else "")
            for m in g.get("milestones", [])
        )
        yield {
            "mentorship_id": mid,
            "source_type": "goal",
            "source_id": _ids(g["_id"]),
            "title": g.get("title", "Goal"),
            "text": "\n\n".join(filter(None, [g.get("title", ""), milestones])),
            "viewers": parties(mid),
            "visibility": "mentorship",
            "owner_id": None,
        }

    # ---- Resources: the title and the note, never the page behind the link ----
    for r in db.resources.find({"mentorship": {"$in": oids}}):
        mid = _ids(r["mentorship"])
        if mid not in mentorships:
            continue

        yield {
            "mentorship_id": mid,
            "source_type": "resource",
            "source_id": _ids(r["_id"]),
            "title": r.get("title", "Resource"),
            "text": "\n\n".join(filter(None, [r.get("title", ""), r.get("note", "")])),
            "viewers": parties(mid),
            "visibility": "mentorship",
            "owner_id": None,
            "url": r.get("url"),
        }
