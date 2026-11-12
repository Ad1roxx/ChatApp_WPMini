"""The rubric's audience and version, as `sources.attachment_entries` decides them (S8 Step 1, D5).

No database: these are the rules the index and the read-time check share. The
end-to-end test, through search and the agent, is in test_sync.py (property 9).
"""

from __future__ import annotations

from datetime import datetime

from bson import ObjectId

import sources

MENTOR, STUDENT, OTHER = "0000000000000000000000b1", "0000000000000000000000a1", "0000000000000000000000b9"
MID = "d00000000000000000000001"
MENTORSHIP = {"_id": ObjectId(MID), "student": ObjectId(STUDENT), "mentor": ObjectId(MENTOR), "status": "active"}
UPLOADED, LATER = datetime(2026, 3, 1), datetime(2026, 3, 2)


def brief(mentor=MENTOR):
    a = {"_id": ObjectId(), "title": "Caching", "instructions": "x", "mentorships": [ObjectId(MID)]}
    if mentor is not None:
        a["mentor"] = ObjectId(mentor)
    return a


def entries(a):
    return sources.attachment_entries(a, sources.record_parent("assignment", a, MENTORSHIP))


def with_file(a, rubric=None, name="rubric.pdf"):
    f = {"fileId": ObjectId(), "name": name, "size": 10, "contentType": "application/pdf", "uploadedAt": UPLOADED}
    if rubric is not None:
        f["rubric"] = rubric
    a.setdefault("attachments", []).append(f)
    return a


def test_an_ordinary_brief_file_has_the_briefs_viewers_and_its_upload_time():
    [e] = entries(with_file(brief()))
    assert sorted(e["viewers"]) == sorted([MENTOR, STUDENT])
    assert e["visibility"] == "mentorship" and e["version"] == UPLOADED


def test_an_unshared_rubric_is_the_setting_mentors_alone():
    [e] = entries(with_file(brief(), {"isRubric": True, "shared": False, "changedAt": LATER}))
    assert e["viewers"] == [MENTOR] and e["visibility"] == "mentor"


def test_a_shared_rubric_has_the_briefs_viewers():
    [e] = entries(with_file(brief(), {"isRubric": True, "shared": True, "changedAt": LATER}))
    assert sorted(e["viewers"]) == sorted([MENTOR, STUDENT]) and e["visibility"] == "mentorship"


def test_the_rubric_narrows_only_its_own_file():
    a = with_file(with_file(brief(), name="brief.pdf"), {"isRubric": True, "shared": False, "changedAt": LATER})
    by_name = {e["title"]: e["viewers"] for e in entries(a)}
    assert sorted(by_name["brief.pdf"]) == sorted([MENTOR, STUDENT]) and by_name["rubric.pdf"] == [MENTOR]


def test_a_rubric_with_no_setting_mentor_or_one_not_in_this_mentorship_is_nobodys():
    [e] = entries(with_file(brief(mentor=None), {"isRubric": True, "shared": False, "changedAt": LATER}))
    assert e["viewers"] == []
    [e] = entries(with_file(brief(mentor=OTHER), {"isRubric": True, "shared": False, "changedAt": LATER}))
    assert e["viewers"] == []


def test_a_rubric_flag_on_a_hand_in_file_changes_nothing():
    s = {"_id": ObjectId(), "assignment": ObjectId(), "mentorship": ObjectId(MID), "student": ObjectId(STUDENT),
         "attachments": [{"fileId": ObjectId(), "name": "mine.pdf", "contentType": "application/pdf", "uploadedAt": UPLOADED,
                          "rubric": {"isRubric": True, "shared": False, "changedAt": LATER}}]}
    [e] = sources.attachment_entries(s, sources.submission_parent(s, {"title": "Caching"}, MENTORSHIP))
    assert sorted(e["viewers"]) == sorted([MENTOR, STUDENT])


def test_flagging_sharing_or_unflagging_makes_a_newer_version_and_never_an_older_one():
    for rubric in ({"isRubric": True, "shared": False, "changedAt": LATER},
                   {"isRubric": True, "shared": True, "changedAt": LATER},
                   {"isRubric": False, "shared": False, "changedAt": LATER}):
        [e] = entries(with_file(brief(), rubric))
        assert e["version"] == LATER, rubric
    [e] = entries(with_file(brief(), {"isRubric": True, "shared": False, "changedAt": datetime(2026, 1, 1)}))
    assert e["version"] == UPLOADED
