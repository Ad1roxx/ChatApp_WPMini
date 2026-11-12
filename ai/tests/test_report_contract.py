"""The draft Express builds (tests/fixtures/s8-draft.json, pinned by
server/test/coverage-report-contract.test.js) is accepted by the export's
strict schema, and exports in both formats with every value in it."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as service
import report_export as rx

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "s8-draft.json").read_text(encoding="utf-8"))
SECRET = "contract-secret"


def test_the_express_draft_fits_the_export_schema_exactly():
    parsed = service.DraftOut.model_validate(FIXTURE)
    assert parsed.model_dump() == FIXTURE, "nothing added, dropped or changed by validation"


@pytest.mark.parametrize("fmt, kind", [("pdf", "application/pdf"), ("docx", "application/vnd.openxmlformats")])
def test_the_route_exports_it(monkeypatch, fmt, kind):
    monkeypatch.setattr(service, "SERVICE_SECRET", SECRET)
    client = TestClient(service.app, client=("127.0.0.1", 50000))
    res = client.post("/reports/export", json={"draft": FIXTURE, "format": fmt}, headers={"X-AI-Secret": SECRET})
    assert res.status_code == 200 and res.headers["content-type"].startswith(kind) and len(res.content) > 1000


@pytest.mark.parametrize("change", [
    lambda d: d.update(total="8 of 15"),
    lambda d: d["sections"][0].update(grade="B"),
    lambda d: d["sections"][0]["criteria"][0].update(label="Excellent"),
    lambda d: d["sections"][0]["criteria"][0].update(score=8),
    lambda d: d["header"].update(grade="B"),
    lambda d: d["sections"][0]["criteria"][0]["evidence"][0].update(verified=False),
    lambda d: d["sections"][0]["lookClosely"][0].update(severity="high"),
    lambda d: d["sections"][1]["points"][0]["evidence"].update(score=1),
    lambda d: d["trends"][0].update(total=3),
])
def test_the_export_refuses_a_draft_with_anything_else_in_it(monkeypatch, change):
    import copy
    monkeypatch.setattr(service, "SERVICE_SECRET", SECRET)
    d = copy.deepcopy(FIXTURE)
    change(d)
    client = TestClient(service.app, client=("127.0.0.1", 50000))
    assert client.post("/reports/export", json={"draft": d, "format": "pdf"}, headers={"X-AI-Secret": SECRET}).status_code == 422


def test_every_value_of_the_express_draft_is_in_the_plan():
    text = " ".join(rx.plan_text(rx.plan(FIXTURE)))
    for s in FIXTURE["sections"]:
        for c in s["criteria"]:
            assert c["criterion"] in text and c["label"] in text
        for x in s["lookClosely"]:
            assert x["why"] in text
