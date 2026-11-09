import hashlib
import io
import json
import time
import uuid
from dataclasses import asdict

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from server.api import create_app
from server.extraction import Line, extract
from server.storage import Settings, Store, durable_write
from server.worker import LEGIBLE_MIN_CHARACTERS, LEGIBLE_MIN_CONFIDENCE, assess_legibility, run_one

ORIGIN = "http://localhost:8000"
HEADERS = {"Origin": ORIGIN, "Content-Type": "application/json"}


@pytest.fixture
def runtime(tmp_path):
    settings = Settings(tmp_path / "state", tmp_path / "work", tmp_path / "archive", ocr=False)
    app = create_app(settings)
    return TestClient(app, base_url=ORIGIN, headers=HEADERS), app.state.store


def capture(client, store, identity=None, complete=True, process=True, **metadata):
    data = bytes([220, 220, 220] * 19 + [20, 20, 20]) * 160   # light page, dark background column at the right edge
    manifest = {"id": identity or str(uuid.uuid4()), "sha256": hashlib.sha256(data).hexdigest(),
        "byte_length": len(data), "kind": "scanner-raw", "width": 20, "height": 160,
        "dpi_x": 200, "dpi_y": 200, "transport_complete": complete,
        "frame": {"format": 1, "depth": 8, "bytes_per_line": 60, "pixels_per_line": 20, "lines": 160, "last_frame": True}}
    manifest.update(metadata)
    assert client.post("/api/captures", json=manifest).status_code == (200 if complete else 422)
    if not complete:
        return
    assert client.put(f"/api/captures/{manifest['id']}/chunks/0", content=data,
                      headers={**HEADERS, "Content-Type": "application/octet-stream"}).status_code == 200
    assert client.post(f"/api/captures/{manifest['id']}/finalize").json()["durable"] is True
    if process:
        assert run_one(store)
    return manifest, data


def state(client):
    response = client.get("/api/state")
    assert response.status_code == 200
    return response.json()


def review(client, identity, vendor=None, date="2026-09-14", clock="17:21:30", complete=True):
    group = next(g for g in state(client)["groups"] if any(r["id"] == identity for r in g["receipts"]))
    return client.post(f"/api/receipts/{identity}", json={"version": group["version"], "date": date, "time": clock,
        "vendor": vendor, "complete": complete, "readable": True})


def prepared(client, group):
    result = client.post(f"/api/groups/{group['id']}/prepare", json={"version": group["version"]})
    assert result.status_code == 200, result.text
    return result.json()


def test_origin_boundary_and_incomplete_rejection(runtime):
    client, store = runtime
    assert client.post("/api/captures", json={}, headers={"Origin": "https://outside.example"}).status_code == 403
    assert client.get("/api/health", headers={"Host": "outside.example"}).status_code == 403
    # Health reports the database's own ladder value, so the two can never disagree.
    assert client.get("/api/health").json()["schema"] == 4
    assert client.get("/").headers["Cross-Origin-Embedder-Policy"] == "require-corp"
    oversized = client.post("/api/captures", content=b"x" * (1048576 + 1))
    assert oversized.status_code == 413
    assert oversized.headers["Cross-Origin-Embedder-Policy"] == "require-corp"
    capture(client, store, complete=False)
    assert not state(client)["groups"]


def test_resume_checksums_and_restart_safe_finalization(runtime):
    client, store = runtime
    manifest, data = capture(client, store)
    response = client.post("/api/captures", json=manifest)
    assert response.json()["finalized"]
    assert client.post(f"/api/captures/{manifest['id']}/finalize").json()["sha256"] == manifest["sha256"]
    changed = {**manifest, "sha256": "0" * 64}
    assert client.post("/api/captures", json=changed).status_code == 409
    restarted = Store(store.settings)
    assert not run_one(restarted)
    groups = state(client)["groups"]
    assert len(groups) == 1 and groups[0]["receipts"][0]["state"] == "ready"
    assert (store.settings.work / "captures" / manifest["id"] / "original.bin").read_bytes() == data


def test_missing_chunks_wrong_checksum_and_changed_retry(runtime):
    client, store = runtime
    identity = str(uuid.uuid4())
    data = bytes(96)
    manifest = {"id": identity, "sha256": "0" * 64, "byte_length": 96, "kind": "scanner-raw", "width": 2, "height": 16,
        "dpi_x": 200, "dpi_y": 200, "transport_complete": True,
        "frame": {"format": 1, "depth": 8, "bytes_per_line": 6, "pixels_per_line": 2, "lines": -1, "last_frame": True}}
    assert client.post("/api/captures", json=manifest).status_code == 200
    assert client.post(f"/api/captures/{identity}/finalize").status_code == 409
    binary = {**HEADERS, "Content-Type": "application/octet-stream"}
    assert client.put(f"/api/captures/{identity}/chunks/0", content=data, headers=binary).status_code == 200
    assert client.put(f"/api/captures/{identity}/chunks/0", content=bytes([1]) * 96, headers=binary).status_code == 409
    assert client.post(f"/api/captures/{identity}/finalize").status_code == 409
    assert not state(client)["groups"]


def test_grouping_vendor_veto_and_manual_split(runtime):
    client, store = runtime
    a, _ = capture(client, store)
    b, _ = capture(client, store)
    unknown, _ = capture(client, store)
    assert review(client, a["id"], "Vendor A").status_code == 200
    assert review(client, b["id"], "Vendor B").status_code == 200
    assert review(client, unknown["id"], clock="17:21:59").status_code == 200
    groups = state(client)["groups"]
    assert sorted(len(g["receipts"]) for g in groups) == [1, 2]
    pair = next(g for g in groups if len(g["receipts"]) == 2)
    result = client.post("/api/groups/membership", json={"groups": {pair["id"]: pair["version"]}, "receipt_ids": [unknown["id"]]})
    assert result.status_code == 200
    assert review(client, unknown["id"]).status_code == 200
    assert len(state(client)["groups"]) == 3  # Explicit split stays split.


def test_stale_approval_missing_time_and_version_binding(runtime):
    client, store = runtime
    manifest, _ = capture(client, store)
    review(client, manifest["id"], clock=None)
    group = state(client)["groups"][0]
    assert client.post(f"/api/groups/{group['id']}/prepare", json={"version": group["version"]}).status_code == 409
    review(client, manifest["id"])
    group = state(client)["groups"][0]
    export = prepared(client, group)
    review(client, manifest["id"], clock="17:22")
    assert client.post(f"/api/groups/{group['id']}/approve", json={"export_id": export["id"], "version": group["version"]}).status_code == 409


def test_approval_pdf_cleanup_and_idempotence(runtime):
    client, store = runtime
    manifest, _ = capture(client, store)
    review(client, manifest["id"])
    group = state(client)["groups"][0]
    export = prepared(client, group)
    assert export["path"] == "2026/09-September/20260914-1721.pdf"
    request = {"export_id": export["id"], "version": group["version"]}
    assert client.post(f"/api/groups/{group['id']}/approve", json=request).status_code == 202
    assert review(client, manifest["id"]).status_code == 409
    assert run_one(store)
    assert run_one(store)  # Cleanup after durable commit, without Drive.
    assert client.post(f"/api/groups/{group['id']}/approve", json=request).status_code == 202
    pdf = client.get(f"/api/exports/{export['id']}/pdf")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    assert b"/CCITTFaxDecode" in pdf.content
    assert not (store.settings.work / "captures" / manifest["id"] / "original.bin").exists()
    assert client.get(f"/api/receipts/{manifest['id']}/image?top=0").status_code == 200
    archived = json.loads((store.settings.archive / ".exports" / export["id"] / "manifest.json").read_text())
    with Image.open(archived["masters"][0]["path"]) as image:
        assert image.size == (20, 160) and image.mode != "1"
        assert image.info["dpi"] == (200, 200)
    with Image.open(archived["enhanced"][0]["path"]) as image:
        assert image.mode == "1" and image.size == (19, 160)  # striped scan ends on a dark edge column
        assert image.info["compression"] == "group4"


def test_collision_reservations_preserve_existing_files(runtime):
    client, store = runtime
    external = store.settings.archive / "2026/09-September/20260914-1721.pdf"
    durable_write(external, b"existing user artifact")
    for vendor in ("Vendor A", "Vendor B"):
        manifest, _ = capture(client, store)
        review(client, manifest["id"], vendor)
    exports = [prepared(client, group) for group in state(client)["groups"]]
    assert {item["path"].split("/")[-1] for item in exports} == {"20260914-1721-1.pdf", "20260914-1721-2.pdf"}
    assert external.read_bytes() == b"existing user artifact"


def test_approval_failure_retains_source_and_recovers(runtime, monkeypatch):
    client, store = runtime
    manifest, data = capture(client, store)
    review(client, manifest["id"])
    group = state(client)["groups"][0]
    export = prepared(client, group)
    client.post(f"/api/groups/{group['id']}/approve", json={"export_id": export["id"], "version": group["version"]})
    import server.worker as worker
    original = worker.durable_write

    def disk_full(path, *args, **kwargs):
        if str(path).startswith(str(store.settings.archive)):
            raise OSError("disk full")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(worker, "durable_write", disk_full)
    assert run_one(store)
    assert (store.settings.work / "captures" / manifest["id"] / "original.bin").read_bytes() == data
    assert client.get(f"/api/exports/{export['id']}/pdf").status_code == 404
    monkeypatch.setattr(worker, "durable_write", original)
    with store.transaction() as connection:
        connection.execute("UPDATE jobs SET available=0 WHERE state='pending'")
    assert run_one(store)
    assert client.get(f"/api/exports/{export['id']}/pdf").status_code == 200


def test_expired_job_lease_is_reclaimed_once(runtime):
    client, store = runtime
    with store.transaction() as connection:
        store.enqueue(connection, "cleanup", str(uuid.uuid4()))
    first = store.claim()
    assert store.claim() is None
    with store.transaction() as connection:
        connection.execute("UPDATE jobs SET lease_until=? WHERE id=?", (time.time() - 1, first["id"]))
    second = store.claim()
    assert first["id"] == second["id"] and first["owner"] != second["owner"]


def test_crash_after_pdf_finalization_reuses_identical_bytes(runtime, monkeypatch):
    client, store = runtime
    manifest, _ = capture(client, store)
    review(client, manifest["id"])
    group = state(client)["groups"][0]
    export = prepared(client, group)
    client.post(f"/api/groups/{group['id']}/approve", json={"export_id": export["id"], "version": group["version"]})
    import server.worker as worker
    original = worker.durable_write
    destination = store.settings.archive / export["path"]

    def crash_after_write(path, *args, **kwargs):
        original(path, *args, **kwargs)
        if path == destination:
            raise OSError("process died before database commit")

    monkeypatch.setattr(worker, "durable_write", crash_after_write)
    run_one(store)
    saved = destination.read_bytes()
    assert state(client)["groups"][0]["state"] == "finalizing"
    monkeypatch.setattr(worker, "durable_write", original)
    with store.transaction() as connection:
        connection.execute("UPDATE jobs SET available=0 WHERE state='pending'")
    run_one(store)
    assert state(client)["groups"][0]["state"] == "approved"
    assert destination.read_bytes() == saved


def test_process_lease_replay_after_approval_cleanup_is_safe(runtime):
    client, store = runtime
    manifest, _ = capture(client, store)
    with store.transaction() as connection:
        connection.execute("UPDATE jobs SET state='running',owner='interrupted',lease_until=? WHERE kind='process'", (time.time() + 300,))
    review(client, manifest["id"])
    group = state(client)["groups"][0]
    export = prepared(client, group)
    client.post(f"/api/groups/{group['id']}/approve", json={"export_id": export["id"], "version": group["version"]})
    assert run_one(store) and run_one(store)
    with store.transaction() as connection:
        connection.execute("UPDATE jobs SET lease_until=0 WHERE kind='process'")
    assert run_one(store)
    receipt = state(client)["groups"][0]["receipts"][0]
    assert receipt["state"] == "ready"
    assert all(job["state"] == "done" for job in state(client)["jobs"])


def test_drive_outage_does_not_block_local_approval_or_cleanup(runtime):
    client, store = runtime
    manifest, _ = capture(client, store)
    review(client, manifest["id"])
    class OfflineDrive:
        def status(self):
            return {"configured": True, "connected": True}

        def names(self, parent):
            raise ValueError("temporarily unavailable")

    offline = TestClient(create_app(store.settings, OfflineDrive()), base_url=ORIGIN, headers=HEADERS)
    group = state(offline)["groups"][0]
    export = prepared(offline, group)
    assert "unavailable" in export["note"]
    offline.post(f"/api/groups/{group['id']}/approve", json={"export_id": export["id"], "version": group["version"]})
    assert run_one(store) and run_one(store)
    assert state(offline)["groups"][0]["state"] == "approved"
    assert offline.get(f"/api/exports/{export['id']}/pdf").status_code == 200


def test_delete_scan_removes_files_and_prevents_upload_resurrection(runtime):
    client, store = runtime
    manifest, _ = capture(client, store)
    identity = manifest['id']
    group = state(client)['groups'][0]
    url = f'/api/receipts/{identity}'
    assert client.request('DELETE', url, json={'version': group['version'] + 1}).status_code == 409
    assert client.request('DELETE', url, json={'version': group['version']}).json() == {'deleted': True}
    assert not state(client)['groups']
    assert not state(client)['jobs']
    assert not (store.settings.work / 'captures' / identity).exists()
    assert client.get(url + '/image').status_code == 404
    assert client.post('/api/captures', json=manifest).status_code == 410
    assert client.post(f'/api/captures/{identity}/finalize').status_code == 410


def test_delete_page_invalidates_reservation_and_preserves_other_pages(runtime):
    client, store = runtime
    first, _ = capture(client, store)
    second, _ = capture(client, store)
    for manifest in (first, second):
        assert review(client, manifest['id']).status_code == 200
    group = state(client)['groups'][0]
    assert len(group['receipts']) == 2
    reservation = prepared(client, group)
    assert client.request('DELETE', f"/api/receipts/{first['id']}", json={'version': group['version']}).status_code == 200
    remaining = state(client)['groups'][0]
    assert remaining['version'] > group['version']
    assert [r['id'] for r in remaining['receipts']] == [second['id']]
    assert remaining['receipts'][0]['page_order'] == 1
    assert not remaining['exports']
    assert client.post(f"/api/groups/{group['id']}/approve", json={'version': group['version'], 'export_id': reservation['id']}).status_code == 409


def test_delete_blocks_running_processing_and_approved_groups(runtime):
    client, store = runtime
    manifest, _ = capture(client, store)
    identity = manifest['id']
    group = state(client)['groups'][0]
    with store.transaction() as connection:
        connection.execute("UPDATE jobs SET state='running' WHERE target=?", (identity,))
    assert client.request('DELETE', f'/api/receipts/{identity}', json={'version': group['version']}).status_code == 409
    with store.transaction() as connection:
        connection.execute("UPDATE jobs SET state='done' WHERE target=?", (identity,))
        connection.execute("UPDATE groups SET state='approved' WHERE id=?", (group['id'],))
    assert client.request('DELETE', f'/api/receipts/{identity}', json={'version': group['version']}).status_code == 409
    assert (store.settings.work / 'captures' / identity).exists()


def test_timestamp_strip_shows_only_the_accepted_candidate_region(runtime, monkeypatch):
    import server.worker as worker
    client, store = runtime
    # A page without an accepted OCR timestamp region answers honestly instead of blank-cropping.
    plain, _ = capture(client, store)
    assert client.get(f"/api/receipts/{plain['id']}/timestamp-strip").status_code == 404
    store.settings.ocr = True
    lines = [Line("2026-09-14 17:21:30", (0, 10, 500, 30), 95, "discovery"),
             Line("2026-09-14 17:21:30", (0, 10, 500, 30), 95, "tile-00")]
    proposal = extract(lines)
    assert proposal["selected"], "the fixture must produce an accepted candidate"
    monkeypatch.setattr(worker, "recognize", lambda *args, **kwargs: {"state": "done", "engine": "fixture", "extraction": proposal})
    manifest, _ = capture(client, store)
    strip = client.get(f"/api/receipts/{manifest['id']}/timestamp-strip")
    assert strip.status_code == 200 and strip.headers["content-type"] == "image/png"
    image = Image.open(io.BytesIO(strip.content))
    box = next(item["box"] for item in proposal["candidates"] if item["id"] == proposal["selected"]["candidate_id"])
    # Bilevel, full master width clamped to the page, the candidate rows padded by the line height.
    assert image.mode == "1" and image.size == (20, 41)
    assert box[1] == 10 and box[3] == 30


def test_approved_export_deletion_purges_rows_and_files(runtime):
    client, store = runtime
    manifest, _ = capture(client, store)
    review(client, manifest["id"])
    group = state(client)["groups"][0]
    export = prepared(client, group)
    assert client.post(f"/api/groups/{group['id']}/approve",
                       json={"export_id": export["id"], "version": group["version"]}).status_code == 202
    reserved = state(client)["groups"][0]["version"]
    # Stale views, unknown ids, and a still-finalizing export are all refused.
    assert client.request("DELETE", f"/api/exports/{export['id']}", json={"version": reserved - 1}).status_code == 409
    assert client.request("DELETE", f"/api/exports/{str(uuid.uuid4())}", json={"version": reserved}).status_code == 404
    assert client.request("DELETE", f"/api/exports/{export['id']}", json={"version": reserved}).status_code == 409
    assert run_one(store) and run_one(store)  # Durable commit, then cleanup.
    assert state(client)["groups"][0]["state"] == "approved"
    archived_pdf = store.settings.archive / export["path"]
    assert archived_pdf.exists() and (store.settings.archive / ".exports" / export["id"]).is_dir()
    assert client.request("DELETE", f"/api/exports/{export['id']}", json={"version": reserved - 1}).status_code == 409
    assert client.request("DELETE", f"/api/exports/{export['id']}", json={"version": reserved}).status_code == 200
    assert state(client)["groups"] == []
    assert not archived_pdf.exists()
    assert not (store.settings.archive / ".exports" / export["id"]).exists()
    assert not (store.settings.work / "captures" / manifest["id"]).exists()
    with store.transaction() as connection:
        assert not connection.execute("SELECT 1 FROM exports WHERE id=?", (export["id"],)).fetchone()
        assert not connection.execute("SELECT 1 FROM groups WHERE id=?", (group["id"],)).fetchone()
        assert not connection.execute("SELECT 1 FROM receipts WHERE id=?", (manifest["id"],)).fetchone()
        assert not connection.execute("SELECT 1 FROM captures WHERE id=?", (manifest["id"],)).fetchone()
        assert not connection.execute("SELECT 1 FROM jobs WHERE target=? OR target=?",
                                      (export["id"], manifest["id"])).fetchone()
    # A repeat delete finds nothing; the freed dated path can serve a rescanned receipt.
    assert client.request("DELETE", f"/api/exports/{export['id']}", json={"version": reserved}).status_code == 404
    second, _ = capture(client, store)
    review(client, second["id"])
    assert prepared(client, state(client)["groups"][0])["path"] == export["path"]


def test_automatic_proposal_prefills_fields_but_cannot_confirm_itself(runtime, monkeypatch):
    from server.extraction import Line, extract
    import server.worker as worker
    client, store = runtime
    store.settings.ocr = True
    selected = extract([Line("2026-09-14 17:21:30", (0, 10, 500, 30), 95, "discovery"),
                        Line("2026-09-14 17:21:30", (0, 10, 500, 30), 95, "tile-00")])
    monkeypatch.setattr(worker, "recognize", lambda *args, **kwargs: {"state": "done", "engine": "fixture", "extraction": selected})
    first, _ = capture(client, store)
    second, _ = capture(client, store)
    group = state(client)["groups"][0]
    assert len(group["receipts"]) == 2  # Automatic same-minute proposals group incrementally.
    assert all(r["date"] == "2026-09-14" and r["time"] == "17:21:30" for r in group["receipts"])
    assert all(r["field_source"] == "ocr" and r["timestamp_review"] for r in group["receipts"])
    with store.transaction() as connection:
        connection.execute("UPDATE receipts SET complete=1,readable=1")
    rejected = client.post(f"/api/groups/{group['id']}/prepare", json={"version": group["version"]})
    assert rejected.status_code == 409 and "Confirm" in rejected.json()["detail"]
    for manifest in (first, second):
        assert review(client, manifest["id"]).status_code == 200
    group = state(client)["groups"][0]
    assert all(r["field_source"] == "manual" and r["timestamp_review"] == 0 for r in group["receipts"])
    assert prepared(client, group)["path"].endswith("20260914-1721.pdf")


def test_scan_expected_month_resolves_ambiguous_numeric_dates(runtime, monkeypatch):
    from server.extraction import Line, extract
    import server.worker as worker
    client, store = runtime
    store.settings.ocr = True
    def fixture_recognize(image, **kwargs):
        lines = [Line("05/09/2022 12:21:41", (0, 10, 500, 30), 95, "discovery"),
                 Line("05/09/2022 12:21:41", (0, 10, 500, 30), 95, "tile-00")]
        return {"state": "done", "engine": "fixture", "extraction": extract(lines, date_order=kwargs.get("date_order"),
            century=kwargs.get("century"), expected_month=kwargs.get("expected_month"))}
    monkeypatch.setattr(worker, "recognize", fixture_recognize)
    capture(client, store, timestamp_policy={"century": 2000, "expected_month": "2022-09"})
    receipt = state(client)["groups"][0]["receipts"][0]
    assert receipt["date"] == "2022-09-05" and receipt["time"] == "12:21:41" and receipt["field_source"] == "ocr"
    assert receipt["analysis"]["policy"]["source"] == "scan_settings"
    assert receipt["analysis"]["policy"]["effective"]["expected_month"] == "2022-09"
    capture(client, store, timestamp_policy={"century": 2000})
    unresolved = next(r for g in state(client)["groups"] for r in g["receipts"] if r["id"] != receipt["id"])
    assert unresolved["date"] is None and unresolved["time"] is None


def test_batch_confirmation_accepts_proposals_and_approves_without_manual_review(runtime, monkeypatch):
    from server.extraction import Line, extract
    import server.worker as worker
    client, store = runtime
    store.settings.ocr = True
    legible = extract([Line("2026-10-05 09:12:44", (0, 10, 500, 30), 95, "discovery"),
                       Line("2026-10-05 09:12:44", (0, 10, 500, 30), 95, "tile-00")])
    ambiguous = extract([Line("01/09/2022 12:21:41", (0, 10, 500, 30), 95, "discovery")])
    results = [legible, legible, ambiguous]
    monkeypatch.setattr(worker, "recognize", lambda *args, **kwargs: {"state": "done", "engine": "fixture", "extraction": results.pop(0)})
    for _ in range(3):
        capture(client, store)
    groups = state(client)["groups"]
    pair = next(g for g in groups if len(g["receipts"]) == 2)
    assert all(r["field_source"] == "ocr" and r["timestamp_review"] for r in pair["receipts"])
    rejected = client.post(f"/api/groups/{pair['id']}/prepare", json={"version": pair["version"]})
    assert rejected.status_code == 409
    confirmed = client.post("/api/receipts/confirm-proposed", json={
        "groups": {g["id"]: g["version"] for g in groups},
        "receipt_ids": [r["id"] for g in groups for r in g["receipts"]]})
    assert confirmed.status_code == 200
    body = confirmed.json()
    assert body["confirmed"] == 2 and body["skipped"] == [{"id": [r["id"] for r in next(g for g in groups if len(g["receipts"]) == 1)["receipts"]][0], "reason": "no-proposal"}]
    refreshed = state(client)["groups"]
    pair = next(g for g in refreshed if len(g["receipts"]) == 2)
    assert all(r["field_source"] == "confirmed" and not r["timestamp_review"] and r["complete"] and r["readable"] for r in pair["receipts"])
    repeat = client.post("/api/receipts/confirm-proposed", json={"groups": {g["id"]: g["version"] for g in refreshed},
        "receipt_ids": [r["id"] for r in pair["receipts"]]})
    assert repeat.json()["confirmed"] == 0 and {item["reason"] for item in repeat.json()["skipped"]} == {"already-confirmed"}
    assert prepared(client, pair)["path"].endswith("20261005-0912.pdf")
    assert client.post(f"/api/groups/{pair['id']}/approve", json={"version": pair["version"], "export_id": prepared(client, pair)["id"]}).status_code == 202
    stale = client.post("/api/receipts/confirm-proposed", json={"groups": {g["id"]: g["version"] for g in groups},
        "receipt_ids": [r["id"] for r in pair["receipts"]]})
    assert stale.status_code == 409


def test_attest_moves_only_the_two_operator_flags_and_never_regroups(runtime):
    client, store = runtime
    capture(client, store)
    group = state(client)["groups"][0]
    page = group["receipts"][0]
    assert page["complete"] and page["complete_source"] == "transport" and not page["readable"]
    assert client.post(f"/api/receipts/{page['id']}/attest",
        json={"version": group["version"] + 1, "complete": True, "readable": True}).status_code == 409
    # The operator may overrule the transport report: that is still only a flag change.
    assert client.post(f"/api/receipts/{page['id']}/attest",
        json={"version": group["version"], "complete": False, "readable": False}).status_code == 200
    denied = state(client)["groups"][0]
    assert not denied["receipts"][0]["complete"] and denied["receipts"][0]["complete_source"] == "operator"
    assert client.post(f"/api/receipts/{page['id']}/attest",
        json={"version": denied["version"], "complete": True, "readable": True}).status_code == 200
    after = state(client)["groups"]
    assert len(after) == 1 and after[0]["id"] == group["id"]
    attested = after[0]["receipts"][0]
    assert attested["complete"] and attested["readable"] and after[0]["version"] == denied["version"] + 1
    assert attested["complete_source"] == attested["readable_source"] == "operator"
    for field in ("date", "time", "vendor", "field_source", "timestamp_review", "state", "error", "group_id"):
        assert attested[field] == page[field], field
    waiting = capture(client, store, process=False)
    waiting_group = next(g for g in state(client)["groups"] if any(r["id"] == waiting[0]["id"] for r in g["receipts"]))
    assert next(r for r in waiting_group["receipts"] if r["id"] == waiting[0]["id"])["state"] != "ready"
    assert client.post(f"/api/receipts/{waiting[0]['id']}/attest",
        json={"version": waiting_group["version"], "complete": True, "readable": True}).status_code == 409


def test_transport_seeds_the_bottom_flag_but_legibility_stays_mine(runtime):
    client, store = runtime
    capture(client, store)
    group = state(client)["groups"][0]
    receipt = group["receipts"][0]
    assert receipt["complete"] == 1 and receipt["complete_source"] == "transport"
    assert receipt["readable"] == 0 and receipt["readable_source"] is None
    # A measured bottom does not unlock approval while legibility is unattested.
    assert client.post(f"/api/groups/{group['id']}/prepare", json={"version": group["version"]}).status_code == 409


DENSE_READ = ["MARTHA'S CORNER CAFE 42 RIVER ROAD", "CARD **** 8821", "VISA DEBIT 12.40",
              "SUBTOTAL 9.95 TAX 2.45", "TOTAL 12.40", "2026-09-14 17:21:30", "AUTH 448312 REF 92A1"]


def fake_ocr(monkeypatch, lines):
    import server.worker as worker
    def recognize(*args, **kwargs):
        return {"state": "done", "version": "fixture", "engine": "fixture", "backend": {"kind": "fixture"},
                "lines": [asdict(line) for line in lines], "failures": [], "passes": [],
                "text": "\n".join(line.text for line in lines), "seconds": 1, "initialization_seconds": 0,
                "extraction": extract(lines, date_order=kwargs.get("date_order"), century=kwargs.get("century"))}
    monkeypatch.setattr(worker, "recognize", recognize)


def test_confident_dense_ocr_auto_attests_legibility_with_provenance(runtime, monkeypatch):
    client, store = runtime
    store.settings.ocr = True
    lines = [Line(text, (0, 10, 500, 40), 88, source) for text in DENSE_READ for source in ("primary/discovery", "primary/tile-00")]
    fake_ocr(monkeypatch, lines)
    manifest, _ = capture(client, store)
    group = state(client)["groups"][0]
    receipt = group["receipts"][0]
    assert receipt["readable"] == 1 and receipt["readable_source"] == "ocr"
    assert receipt["complete"] == 1 and receipt["complete_source"] == "transport", "legibility and bottom stay separately sourced"
    # Auto-legibility must not open the approval gate on its own: the timestamp still needs the operator.
    assert client.post(f"/api/groups/{group['id']}/prepare", json={"version": group["version"]}).status_code == 409
    confirmed = client.post("/api/receipts/confirm-proposed", json={"groups": {group["id"]: group["version"]},
                                                                    "receipt_ids": [manifest["id"]]})
    assert confirmed.status_code == 200 and confirmed.json()["confirmed"] == 1
    confirmed_page = state(client)["groups"][0]["receipts"][0]
    assert confirmed_page["readable_source"] == "operator", "confirming a proposal re-attributes legibility to the operator"
    assert prepared(client, state(client)["groups"][0])


def test_sparse_or_shaky_recognition_never_auto_attests_legibility(runtime, monkeypatch):
    client, store = runtime
    store.settings.ocr = True
    fake_ocr(monkeypatch, [Line("TOTAL", (0, 10, 500, 40), 98, "primary/discovery"),
                           Line("THANK YOU", (0, 60, 500, 90), 96, "primary/discovery")])
    sparse, _ = capture(client, store, identity=str(uuid.uuid4()))
    fake_ocr(monkeypatch, [Line(text, (0, 10, 500, 40), 40, "primary/discovery") for text in DENSE_READ])
    shaky, _ = capture(client, store, identity=str(uuid.uuid4()))
    for identity in (sparse["id"], shaky["id"]):
        receipt = next(r for g in state(client)["groups"] for r in g["receipts"] if r["id"] == identity)
        assert not receipt["readable"] and receipt["readable_source"] is None, identity


def test_operator_legibility_ruling_survives_reanalysis_even_against_a_perfect_read(runtime, monkeypatch):
    client, store = runtime
    store.settings.ocr = True
    lines = [Line(text, (0, 10, 500, 40), 92, "primary/discovery") for text in DENSE_READ]
    fake_ocr(monkeypatch, lines)
    manifest, _ = capture(client, store)
    identity = manifest["id"]
    group = state(client)["groups"][0]
    assert state(client)["groups"][0]["receipts"][0]["readable_source"] == "ocr"
    # The operator overrules the machine: the page is unreadable to human eyes despite clean OCR.
    assert client.post(f"/api/receipts/{identity}", json={"version": group["version"], "date": "2026-09-14",
        "time": "17:21:30", "vendor": None, "complete": True, "readable": False}).status_code == 200
    group = state(client)["groups"][0]
    assert client.post(f"/api/receipts/{identity}/analyze", json={"version": group["version"],
        "date_order": "MDY", "century": 2000}).status_code == 202
    assert run_one(store)
    receipt = state(client)["groups"][0]["receipts"][0]
    assert not receipt["readable"] and receipt["readable_source"] == "operator", "a reanalysis may not re-attest over a human ruling"
    assert client.post(f"/api/groups/{group['id']}/prepare", json={"version": group["version"]}).status_code == 409


def test_legibility_assessment_dedupes_passes_and_weights_by_characters():
    assert assess_legibility({"ocr": None}) is None
    dense = {"ocr": {"lines": [{"text": text, "confidence": 88, "source": "primary/discovery"} for text in DENSE_READ]}}
    stats = assess_legibility(dense)
    assert stats and stats["characters"] >= LEGIBLE_MIN_CHARACTERS and stats["confidence"] >= LEGIBLE_MIN_CONFIDENCE
    doubled = {"ocr": {"lines": dense["ocr"]["lines"] + [{"text": text, "confidence": 55, "source": "fallback/tile"} for text in DENSE_READ]}}
    assert assess_legibility(doubled) == stats, "a weaker duplicate pass must not drag the verdict down or double-count characters"
    assert assess_legibility({"ocr": {"lines": [{"text": text, "confidence": 40, "source": "p"} for text in DENSE_READ]}}) is None
    assert assess_legibility({"ocr": {"lines": [{"text": "OK", "confidence": 99, "source": "p"}] * 40}}) is None, "repeats of one short line dedupe to two characters, not eighty"


def test_image_imports_claim_transport_but_prove_nothing(runtime):
    from io import BytesIO
    client, store = runtime
    buffer = BytesIO()
    Image.new("L", (20, 160), 220).save(buffer, "PNG")
    data = buffer.getvalue()
    manifest = {"id": str(uuid.uuid4()), "sha256": hashlib.sha256(data).hexdigest(), "byte_length": len(data),
        "kind": "image", "width": 20, "height": 160, "dpi_x": 200, "dpi_y": 200, "transport_complete": True}
    assert client.post("/api/captures", json=manifest).status_code == 200
    assert client.put(f"/api/captures/{manifest['id']}/chunks/0", content=data,
                      headers={**HEADERS, "Content-Type": "application/octet-stream"}).status_code == 200
    assert client.post(f"/api/captures/{manifest['id']}/finalize").json()["durable"] is True
    receipt = next(r for g in state(client)["groups"] for r in g["receipts"] if r["id"] == manifest["id"])
    assert not receipt["complete"] and receipt["complete_source"] is None


def test_ambiguous_extraction_keeps_manual_fields_empty(runtime, monkeypatch):
    from server.extraction import Line, extract
    import server.worker as worker
    client, store = runtime
    store.settings.ocr = True
    result = extract([Line("01/09/2022 12:21:41", (0, 10, 500, 30), 95, "discovery")])
    monkeypatch.setattr(worker, "recognize", lambda *args, **kwargs: {"state": "done", "extraction": result})
    manifest, _ = capture(client, store)
    receipt = state(client)["groups"][0]["receipts"][0]
    assert receipt["date"] is None and receipt["time"] is None
    evidence = client.get(f"/api/receipts/{manifest['id']}/evidence").json()["processing"]
    assert evidence["extraction"]["status"] == "needs_review"
    assert "ambiguous_numeric_date" in evidence["extraction"]["issues"]


def test_schema_one_migration_preserves_manual_timestamps(tmp_path):
    import sqlite3
    settings = Settings(tmp_path / "state", tmp_path / "work", tmp_path / "archive", ocr=False)
    settings.state.mkdir()
    connection = sqlite3.connect(settings.state / "receipts.sqlite3")
    connection.executescript("""CREATE TABLE receipts(id TEXT PRIMARY KEY, date TEXT, time TEXT);
      INSERT INTO receipts VALUES('manual','2021-12-21','12:45:42');
      INSERT INTO receipts VALUES('missing','2021-12-21',NULL);
      PRAGMA user_version=1;""")
    connection.close()
    store = Store(settings)
    with store.transaction() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 4
        manual = dict(connection.execute("SELECT * FROM receipts WHERE id='manual'").fetchone())
        assert manual["date"] == "2021-12-21" and manual["time"] == "12:45:42"
        assert manual["field_source"] == "manual" and manual["timestamp_review"] == 0
        assert manual["complete_source"] is None  # legacy rows keep unknown provenance, not invented provenance
        missing = dict(connection.execute("SELECT * FROM receipts WHERE id='missing'").fetchone())
        assert missing["time"] is None and missing["timestamp_review"] == 1


def test_worker_fallback_proposal_retains_sources_and_requires_confirmation(runtime, monkeypatch):
    from test_ocr_fallback import Client, evidence
    import server.worker as worker
    client, store = runtime
    manifest, original = capture(client, store)
    primary = evidence(supported=False)
    monkeypatch.setattr(worker, "recognize", lambda *args, **kwargs: primary)
    store.settings.ocr = True
    initial = state(client)["groups"][0]
    assert client.post(f"/api/receipts/{manifest['id']}/analyze", json={"version": initial["version"], "mode": "ocr"}).status_code == 202
    fallback = Client(evidence())
    assert run_one(store, fallback=fallback)
    group = state(client)["groups"][0]
    receipt = group["receipts"][0]
    assert (receipt["date"], receipt["time"]) == ("2026-09-14", "17:21:30")
    assert receipt["timestamp_review"] == 1 and receipt["field_source"] == "ocr"
    result = client.get(f"/api/receipts/{manifest['id']}/evidence").json()["processing"]
    assert result["ocr"]["fallback"]["state"] == "accepted"
    assert result["extraction"]["routing"]["selected_engine"] == "rapidocr"
    assert result["ocr"]["fallback"]["primary_extraction"] == primary["extraction"]
    assert (store.settings.work / "captures" / manifest["id"] / "original.bin").read_bytes() == original
    with store.transaction() as connection:
        connection.execute("UPDATE receipts SET complete=1,readable=1")
    assert client.post(f"/api/groups/{group['id']}/prepare", json={"version": group["version"]}).status_code == 409
    assert review(client, manifest["id"]).status_code == 200


def test_worker_fallback_timeout_retains_staging_and_manual_review(runtime, monkeypatch):
    from test_ocr_fallback import Client, evidence
    import server.worker as worker
    client, store = runtime
    manifest, original = capture(client, store)
    monkeypatch.setattr(worker, "recognize", lambda *args, **kwargs: evidence(supported=False))
    store.settings.ocr = True
    initial = state(client)["groups"][0]
    assert client.post(f"/api/receipts/{manifest['id']}/analyze", json={"version": initial["version"], "mode": "ocr"}).status_code == 202
    assert run_one(store, fallback=Client(None, "timeout"))
    receipt = state(client)["groups"][0]["receipts"][0]
    assert receipt["state"] == "ready" and receipt["date"] is None and receipt["time"] is None
    assert (store.settings.work / "captures" / manifest["id"] / "original.bin").read_bytes() == original
    assert review(client, manifest["id"]).status_code == 200
