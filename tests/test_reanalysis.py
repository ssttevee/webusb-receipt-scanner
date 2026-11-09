from copy import deepcopy
from dataclasses import asdict
import json

import pytest

from server.extraction import Line, extract
from server.reanalysis import reparse_ocr
from server.worker import run_one
from test_application import capture, prepared, review, runtime as runtime_fixture, state

runtime = runtime_fixture


@pytest.fixture
def cached(runtime, monkeypatch):
    import server.worker as worker
    client, store = runtime
    store.settings.ocr = True
    def recognize(*args, **kwargs):
        lines = [Line("06/01/24 17:06:29", (0, 10, 500, 30), 95, source) for source in ("discovery", "tile-00")]
        return {"state": "done", "version": "fixture", "engine": "fixture", "backend": {"kind": "fixture"},
                "lines": [asdict(line) for line in lines], "failures": [], "passes": [], "text": lines[0].text,
                "seconds": 1, "initialization_seconds": 0,
                "extraction": extract(lines, date_order=kwargs.get("date_order"), century=kwargs.get("century"))}
    monkeypatch.setattr(worker, "recognize", recognize)
    manifest, data = capture(client, store)
    return client, store, manifest, data


def request(client, identity, **policy):
    group = next(group for group in state(client)["groups"] if any(r["id"] == identity for r in group["receipts"]))
    return client.post(f"/api/receipts/{identity}/analyze", json={"version": group["version"], "date_order": "MDY", "century": 2000, **policy})


def test_policy_reparse_uses_saved_lines_and_preserves_immutable_history(cached, monkeypatch):
    import server.worker as worker
    client, store, manifest, original = cached
    identity = manifest["id"]
    old = state(client)["groups"][0]["receipts"][0]["analysis"]
    before = client.get(f"/api/receipts/{identity}/evidence?analysis_id={old['id']}").json()
    assert before["processing"]["extraction"]["selected"] is None
    response = request(client, identity)
    assert response.status_code == 202
    assert response.json()["analysis"]["policy"]["effective"] == {"date_order": "MDY", "century": 2000, "expected_month": None}
    monkeypatch.setattr(worker, "recognize", lambda *args, **kwargs: pytest.fail("cached reparse must not rerun OCR"))
    assert run_one(store)
    receipt = state(client)["groups"][0]["receipts"][0]
    assert (receipt["date"], receipt["time"]) == ("2024-06-01", "17:06:29")
    assert receipt["timestamp_review"] == 1 and receipt["analysis"]["mode"] == "parse"
    assert client.get(f"/api/receipts/{identity}/evidence?analysis_id={old['id']}").json() == before
    assert len(client.get(f"/api/receipts/{identity}/analyses").json()["analyses"]) == 2
    assert (store.settings.work / "captures" / identity / "original.bin").read_bytes() == original


def test_policy_is_receipt_local_and_snapshots_application_defaults(cached):
    client, store, first, _ = cached
    second, _ = capture(client, store)
    store.settings.date_order, store.settings.year_century = "MDY", 2000
    response = request(client, first["id"], date_order="inherit", century="inherit")
    assert response.status_code == 202
    store.settings.date_order, store.settings.year_century = "DMY", 1900
    run_one(store)
    receipts = {r["id"]: r for group in state(client)["groups"] for r in group["receipts"]}
    assert receipts[first["id"]]["date"] == "2024-06-01"
    assert receipts[second["id"]]["date"] is None
    assert request(client, first["id"], date_order=None, century=None).status_code == 202
    run_one(store)
    receipt = next(r for group in state(client)["groups"] for r in group["receipts"] if r["id"] == first["id"])
    assert receipt["date"] is None
    assert receipt["analysis"]["policy"]["effective"] == {"date_order": None, "century": None, "expected_month": None}


@pytest.mark.parametrize("century,expected", [(2000, "2024-06-01"), (1900, "1924-06-01"), (None, None)])
def test_scan_century_survives_queue_delay_and_upload_retry(cached, century, expected):
    client, store, _, _ = cached
    store.settings.date_order = "MDY"
    manifest, _ = capture(client, store, process=False, timestamp_policy={"century": century})
    queued = next(r for g in state(client)["groups"] for r in g["receipts"] if r["id"] == manifest["id"])
    assert queued["analysis"]["policy"]["effective"]["century"] == century
    assert queued["analysis"]["policy"]["source"] == "scan_settings"
    store.settings.year_century, store.settings.date_order = 1900, "DMY"
    assert client.post("/api/captures", json=manifest).status_code == 200
    assert client.post("/api/captures", json={**manifest, "timestamp_policy": {"century": 1900 if century != 1900 else 2000}}).status_code == 409
    assert run_one(store)
    receipt = next(r for g in state(client)["groups"] for r in g["receipts"] if r["id"] == manifest["id"])
    assert receipt["date"] == expected and receipt["timestamp_review"] == 1
    saved = client.get(f"/api/receipts/{manifest['id']}/evidence").json()
    assert saved["capture"]["timestamp_policy"] == {"century": century, "expected_month": None}
    assert saved["processing"]["analysis"]["policy"]["effective"] == {"date_order": "MDY", "century": century, "expected_month": None}


def test_default_scan_century_is_snapshotted_before_processing(cached):
    from server.storage import current_century
    client, store, _, _ = cached
    assert store.settings.year_century == current_century()
    store.settings.date_order = "MDY"
    manifest, _ = capture(client, store, process=False)
    store.settings.year_century = 1900
    assert run_one(store)
    receipt = next(r for g in state(client)["groups"] for r in g["receipts"] if r["id"] == manifest["id"])
    assert receipt["date"] == f"{current_century() + 24}-06-01"
    assert client.post("/api/captures", json=manifest).status_code == 200


@pytest.mark.parametrize("setting,expected", [(None, 2000), ("current", 2000), ("1900", 1900), ("2000", 2000), ("none", None)])
def test_environment_century_default_and_overrides(monkeypatch, setting, expected):
    from server.storage import Settings
    monkeypatch.setattr("server.storage.current_century", lambda: 2000)
    if setting is None:
        monkeypatch.delenv("TWO_DIGIT_YEAR_CENTURY", raising=False)
    else:
        monkeypatch.setenv("TWO_DIGIT_YEAR_CENTURY", setting)
    assert Settings.environment().year_century == expected


@pytest.mark.parametrize("policy", [{"century": 2100}, {"century": "2000"}, {"century": 2000, "extra": True},
    {"century": 2000, "expected_month": "2022-13"}, {"century": 2000, "expected_month": "sep-2022"}])
def test_capture_rejects_invalid_scan_policy(cached, policy):
    import uuid
    client, _, manifest, _ = cached
    assert client.post("/api/captures", json={**manifest, "id": str(uuid.uuid4()), "timestamp_policy": policy}).status_code == 422


def test_new_request_supersedes_pending_analysis_and_rejects_stale_versions(cached):
    client, store, manifest, _ = cached
    first = request(client, manifest["id"]).json()
    assert client.post(f"/api/receipts/{manifest['id']}/analyze", json={"version": first["version"] - 1}).status_code == 409
    second = request(client, manifest["id"], date_order="DMY").json()
    assert run_one(store)
    receipt = state(client)["groups"][0]["receipts"][0]
    assert receipt["analysis"]["id"] == second["analysis"]["id"]
    assert receipt["date"] == "2024-01-06"
    history = client.get(f"/api/receipts/{manifest['id']}/analyses").json()["analyses"]
    assert next(r for r in history if r["id"] == first["analysis"]["id"])["state"] == "superseded"


def test_running_superseded_analysis_cannot_write_current_fields(cached, monkeypatch):
    import server.reanalysis as parser
    client, store, manifest, _ = cached
    first = request(client, manifest["id"]).json()["analysis"]["id"]
    original = parser.reparse_ocr
    def supersede(ocr, policy):
        assert request(client, manifest["id"], date_order="DMY").status_code == 202
        return original(ocr, policy)
    monkeypatch.setattr(parser, "reparse_ocr", supersede)
    assert run_one(store)
    receipt = state(client)["groups"][0]["receipts"][0]
    assert receipt["date"] is None and receipt["analysis"]["id"] != first
    old = client.get(f"/api/receipts/{manifest['id']}/evidence?analysis_id={first}").json()
    assert old["analysis"]["state"] == "superseded" and old["processing"]["extraction"]["selected"]["date"] == "2024-06-01"
    monkeypatch.setattr(parser, "reparse_ocr", original)
    assert run_one(store)
    assert state(client)["groups"][0]["receipts"][0]["date"] == "2024-01-06"


def test_manual_edit_during_analysis_wins_over_new_proposal(cached, monkeypatch):
    import server.reanalysis as parser
    client, store, manifest, _ = cached
    request(client, manifest["id"])
    original = parser.reparse_ocr
    def edited(ocr, policy):
        assert review(client, manifest["id"], date="2020-01-02", clock="13:14").status_code == 200
        return original(ocr, policy)
    monkeypatch.setattr(parser, "reparse_ocr", edited)
    run_one(store)
    group = state(client)["groups"][0]
    receipt = group["receipts"][0]
    assert (receipt["date"], receipt["time"]) == ("2020-01-02", "13:14")
    assert receipt["field_source"] == "manual" and receipt["timestamp_review"] == 0
    assert prepared(client, group)


def test_lost_lease_cannot_commit_and_new_owner_reuses_durable_artifact(cached, monkeypatch):
    import server.reanalysis as parser
    import server.worker as worker
    client, store, manifest, _ = cached
    request(client, manifest["id"])
    job = store.claim()
    original, calls = parser.reparse_ocr, []
    def lose_lease(ocr, policy):
        calls.append(True)
        with store.transaction() as connection:
            connection.execute("UPDATE jobs SET owner='new-owner' WHERE id=?", (job["id"],))
        return original(ocr, policy)
    monkeypatch.setattr(parser, "reparse_ocr", lose_lease)
    worker.analyze(store, job["target"], job=job)
    assert state(client)["groups"][0]["receipts"][0]["date"] is None
    new_job = {**job, "owner": "new-owner"}
    worker.analyze(store, job["target"], job=new_job)
    assert len(calls) == 1
    assert state(client)["groups"][0]["receipts"][0]["date"] == "2024-06-01"


def test_pending_analysis_blocks_approval_and_invalidates_reserved_export(cached):
    client, store, manifest, _ = cached
    review(client, manifest["id"])
    group = state(client)["groups"][0]
    export = prepared(client, group)
    request(client, manifest["id"])
    current = state(client)["groups"][0]
    assert not current["exports"]
    assert client.post(f"/api/groups/{group['id']}/approve", json={"version": group["version"], "export_id": export["id"]}).status_code == 409
    response = client.post(f"/api/groups/{current['id']}/prepare", json={"version": current["version"]})
    assert response.status_code == 409 and "analysis" in response.json()["detail"]
    run_one(store)
    assert state(client)["groups"][0]["receipts"][0]["field_source"] == "manual"


def test_reanalysis_failure_keeps_master_and_manual_resolution_available(cached, monkeypatch):
    import server.reanalysis as parser
    client, store, manifest, original = cached
    response = request(client, manifest["id"]).json()
    def failed(*args):
        raise ValueError("Analysis failed in regression fixture")
    monkeypatch.setattr(parser, "reparse_ocr", failed)
    for _ in range(3):
        with store.transaction() as connection:
            connection.execute("UPDATE jobs SET available=0 WHERE kind='analyze'")
        run_one(store)
    receipt = state(client)["groups"][0]["receipts"][0]
    assert receipt["state"] == "ready" and receipt["analysis"]["state"] == "failed"
    assert (store.settings.work / "captures" / manifest["id"] / "original.bin").read_bytes() == original
    assert review(client, manifest["id"]).status_code == 200
    assert prepared(client, state(client)["groups"][0])
    assert response["analysis"]["id"] == receipt["analysis"]["id"]


def test_history_integrity_and_deletion_rules(cached):
    client, store, manifest, _ = cached
    identity = manifest["id"]
    request(client, identity)
    job = store.claim()
    group = state(client)["groups"][0]
    assert client.request("DELETE", f"/api/receipts/{identity}", json={"version": group["version"]}).status_code == 409
    with store.transaction() as connection:
        connection.execute("UPDATE jobs SET state='pending',lease_until=NULL WHERE id=?", (job["id"],))
    run_one(store)
    with store.transaction() as connection:
        old = connection.execute("SELECT * FROM analysis_runs WHERE receipt_id=? ORDER BY version LIMIT 1", (identity,)).fetchone()
    from pathlib import Path
    Path(old["evidence_path"]).write_text("corrupt")
    assert client.get(f"/api/receipts/{identity}/evidence?analysis_id={old['id']}").status_code == 409
    group = state(client)["groups"][0]
    assert client.request("DELETE", f"/api/receipts/{identity}", json={"version": group["version"]}).status_code == 200
    with store.transaction() as connection:
        assert connection.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0] == 0
    assert client.post("/api/captures", json=manifest).status_code == 410


def test_cached_engines_cannot_corroborate_each_others_partial_reads():
    primary = Line("06/01/24 17:06", (0, 10, 500, 30), 95, "primary/discovery")
    secondary = Line("06/01/24 17:06", (0, 10, 500, 30), 95, "fallback/discovery")
    ocr = {"lines": [asdict(primary), asdict(secondary)], "failures": [], "seconds": 1,
           "fallback": {"state": "no_proposal", "failures": [], "primary_failures": []}}
    snapshot = deepcopy(ocr)
    result = reparse_ocr(ocr, {"date_order": "MDY", "century": 2000})
    assert result["extraction"]["selected"] is None
    assert "single_source_ocr_requires_review" in result["extraction"]["issues"]
    assert ocr == snapshot and result["reparse"]["fresh_ocr"] is False


def test_bad_policy_values_and_approved_receipts_are_rejected(cached):
    client, store, manifest, _ = cached
    assert request(client, manifest["id"], century=2100).status_code == 422
    with store.transaction() as connection:
        connection.execute("UPDATE groups SET state='approved'")
    assert request(client, manifest["id"]).status_code == 409


def test_ocr_disabled_after_enqueue_does_not_replace_prior_evidence(cached):
    client, store, manifest, _ = cached
    previous = client.get(f"/api/receipts/{manifest['id']}/evidence").json()["processing"]
    assert request(client, manifest["id"], mode="ocr").status_code == 202
    store.settings.ocr = False
    run_one(store)
    assert client.get(f"/api/receipts/{manifest['id']}/evidence").json()["processing"] == previous


def test_legacy_ready_receipt_gets_a_snapshot_before_reanalysis(cached):
    client, store, manifest, _ = cached
    with store.transaction() as connection:
        evidence = json.loads(connection.execute("SELECT evidence FROM receipts WHERE id=?", (manifest["id"],)).fetchone()[0])
        evidence.pop("analysis")
        connection.execute("UPDATE receipts SET active_analysis=NULL,analysis_version=0,evidence=? WHERE id=?", (json.dumps(evidence), manifest["id"]))
        connection.execute("DELETE FROM analysis_runs WHERE receipt_id=?", (manifest["id"],))
    assert request(client, manifest["id"]).status_code == 202
    assert run_one(store)
    history = client.get(f"/api/receipts/{manifest['id']}/analyses").json()["analyses"]
    assert len(history) == 2 and history[1]["mode"] == "legacy" and history[1]["has_evidence"]
    legacy = client.get(f"/api/receipts/{manifest['id']}/evidence?analysis_id={history[1]['id']}").json()["processing"]
    assert legacy["extraction"]["selected"] is None


def test_schema_two_migration_preserves_confirmation(tmp_path):
    import sqlite3
    from server.storage import Settings, Store
    settings = Settings(tmp_path / "state", tmp_path / "work", tmp_path / "archive", ocr=False)
    settings.state.mkdir()
    with sqlite3.connect(settings.state / "receipts.sqlite3") as connection:
        connection.executescript("""CREATE TABLE receipts(id TEXT PRIMARY KEY, date TEXT, time TEXT, field_source TEXT, timestamp_review INTEGER);
          INSERT INTO receipts VALUES('existing','2024-06-01','17:06:29','manual',0); PRAGMA user_version=2;""")
    store = Store(settings)
    with store.transaction() as connection:
        row = dict(connection.execute("SELECT * FROM receipts").fetchone())
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 4
        assert row["date"] == "2024-06-01" and row["time"] == "17:06:29" and row["timestamp_review"] == 0
        assert row["active_analysis"] is None and row["analysis_version"] == 0
        assert row["complete_source"] is None and row["readable_source"] is None
