"""One-origin API. USB ownership and pending transfer copies stay in the browser."""
from datetime import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import time
from urllib.parse import urlsplit
import uuid

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .drive import Drive
from .analysis_jobs import current_run, ensure_run, processing_active, queue_analysis, read_evidence, run_info
from .models import AnalysisRequest, Approval, Capture, ConfirmProposed, Edit, Membership, Version
from .storage import Settings, Store, digest, durable_write, encode, ensure_directory, sync_directory

ROOT = Path(__file__).resolve().parents[1]
CHUNK_SIZE = 4 * 1048576
MONTHS = ("", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")


def fail(message, code=409):
    raise HTTPException(code, message)


def create_app(settings=None, drive=None):
    settings = settings or Settings.environment()
    store = Store(settings)
    drive = drive or Drive(settings)
    app = FastAPI(title="Receipt staging", docs_url=None, redoc_url=None)
    app.state.store, app.state.drive = store, drive
    expected = urlsplit(settings.public_url)
    if expected.scheme not in ("http", "https") or not expected.netloc or expected.path not in ("", "/"):
        raise ValueError("APP_PUBLIC_URL must be an absolute origin without a path")

    @app.middleware("http")
    async def boundary(request, call_next):
        if request.headers.get("host", "").lower() != expected.netloc.lower():
            response = JSONResponse({"detail": "Request Host does not match APP_PUBLIC_URL"}, status_code=403)
        elif request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("origin") != settings.public_url:
            response = JSONResponse({"detail": "Same-origin request required"}, status_code=403)
        elif request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("content-type", "").split(";")[0] not in ("application/json", "application/octet-stream"):
            response = JSONResponse({"detail": "JSON or binary API content type required"}, status_code=415)
        else:
            # Bound JSON before Pydantic parses it; binary chunks are bounded while streaming.
            if request.headers.get("content-type", "").startswith("application/json"):
                size = 0
                chunks = []
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 1048576:
                        break
                    chunks.append(chunk)
                request._body = b"".join(chunks)
                if size > 1048576:
                    response = JSONResponse({"detail": "Manifest exceeds 1 MiB"}, status_code=413)
                else:
                    response = await call_next(request)
            else:
                response = await call_next(request)
        for header, value in {"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin", "Permissions-Policy": "usb=(self)",
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}.items():
            response.headers[header] = value
        return response

    def group_for_edit(connection, identity, version):
        try:
            group = store.group(connection, identity)
        except LookupError:
            fail("Group no longer exists; refresh", 404)
        if group["state"] != "staging" or group["version"] != version:
            fail("Staging changed or approval has started; refresh before editing")
        return group

    def receipt_row(connection, identity):
        row = connection.execute("SELECT * FROM receipts WHERE id=?", (identity,)).fetchone()
        if not row:
            fail("Receipt not found", 404)
        return dict(row)

    def capture_row(connection, identity):
        row = connection.execute("SELECT * FROM captures WHERE id=?", (identity,)).fetchone()
        if not row:
            fail("Capture not found", 404)
        return row

    @app.get("/api/health")
    def health():
        with store.transaction() as connection:
            connection.execute("SELECT 1").fetchone()
        return {"ok": True, "schema": 3, "driver_ready": (ROOT / "scanner-driver/build/provenance.json").exists(),
                "free_work_bytes": shutil.disk_usage(settings.work).free, "ocr_enabled": settings.ocr,
                "ocr_backend": settings.ocr_backend, "ocr_fallback": settings.ocr_fallback,
                "fallback_timeout_seconds": settings.fallback_timeout}

    @app.post("/api/captures")
    def begin(manifest: Capture):
        metadata = manifest.model_dump()
        if manifest.timestamp_policy is None:
            metadata.pop("timestamp_policy")  # Keep older pending uploads byte-for-byte compatible.
        value = encode(metadata)
        with store.transaction() as connection:
            existing = connection.execute("SELECT * FROM captures WHERE id=?", (manifest.id,)).fetchone()
            if existing:
                if existing["state"] == "deleted":
                    fail("Scan was deleted; capture a new scan", 410)
                if existing["manifest"] != value:
                    fail("Capture ID already belongs to different bytes or metadata")
            else:
                if shutil.disk_usage(settings.work).free < manifest.byte_length * 3 + 64 * 1048576:
                    fail("Insufficient staging space; browser copy retained", 507)
                connection.execute("INSERT INTO captures VALUES(?,?,?,?)", (manifest.id, value, "uploading", time.time()))
            directory = settings.work / "captures" / manifest.id
            received = [int(path.stem.split("-")[1]) for path in directory.glob("chunk-*.bin")]
            return {"id": manifest.id, "chunk_size": CHUNK_SIZE, "received": received,
                    "finalized": bool(existing and existing["state"] == "received")}

    @app.put("/api/captures/{identity}/chunks/{index}")
    async def put_chunk(identity: str, index: int, request: Request):
        data = bytearray()
        async for block in request.stream():
            data.extend(block)
            if len(data) > CHUNK_SIZE:
                fail("Chunk too large", 413)
        with store.transaction() as connection:
            row = capture_row(connection, identity)
            if row["state"] != "uploading":
                fail("Capture already finalized")
            manifest = json.loads(row["manifest"])
            count = (manifest["byte_length"] + CHUNK_SIZE - 1) // CHUNK_SIZE
            expected_size = min(CHUNK_SIZE, manifest["byte_length"] - index * CHUNK_SIZE)
            if index < 0 or index >= count or len(data) != expected_size:
                fail("Chunk index or length is invalid", 422)
            path = settings.work / "captures" / identity / f"chunk-{index:04d}.bin"
            checksum = hashlib.sha256(data).hexdigest()
            if path.exists() and digest(path) != checksum:
                fail("Retry changed a previously stored chunk")
            if not path.exists():
                durable_write(path, data)
        return {"id": identity, "index": index, "sha256": checksum, "durable": True}

    @app.post("/api/captures/{identity}/finalize")
    def finalize(identity: str):
        with store.transaction() as connection:
            row = capture_row(connection, identity)
            manifest = json.loads(row["manifest"])
            if row["state"] == "deleted":
                fail("Scan was deleted; capture a new scan", 410)
            if row["state"] == "received":
                return {"id": identity, "sha256": manifest["sha256"], "durable": True}
            directory = settings.work / "captures" / identity
            count = (manifest["byte_length"] + CHUNK_SIZE - 1) // CHUNK_SIZE
            paths = [directory / f"chunk-{index:04d}.bin" for index in range(count)]
            if any(not path.exists() for path in paths):
                fail("Capture is missing chunks; resume upload")
            ensure_directory(directory)
            descriptor, temporary = tempfile.mkstemp(prefix=".original-", dir=directory)
            try:
                checksum = hashlib.sha256()
                length = 0
                with os.fdopen(descriptor, "wb") as output:
                    for path in paths:
                        data = path.read_bytes()
                        output.write(data)
                        checksum.update(data)
                        length += len(data)
                    output.flush()
                    os.fsync(output.fileno())
                if checksum.hexdigest() != manifest["sha256"] or length != manifest["byte_length"]:
                    fail("Original checksum/length failed; no receipt was committed")
                os.replace(temporary, directory / "original.bin")
                sync_directory(directory)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            durable_write(directory / "capture.json", row["manifest"].encode())
            connection.execute("UPDATE captures SET state='received' WHERE id=?", (identity,))
            group_id = str(uuid.uuid4())
            now = time.time()
            connection.execute("INSERT INTO groups(id,created) VALUES(?,?)", (group_id, now))
            connection.execute("INSERT INTO receipts(id,group_id,languages,created) VALUES(?,?,?,?)",
                               (identity, group_id, encode(manifest["languages"]), now))
            ensure_run(store, connection, connection.execute("SELECT * FROM receipts WHERE id=?", (identity,)).fetchone())
            store.enqueue(connection, "process", identity)
        return {"id": identity, "sha256": manifest["sha256"], "durable": True}

    @app.get("/api/state")
    def state():
        with store.transaction() as connection:
            groups = [dict(row) for row in connection.execute("SELECT * FROM groups ORDER BY created DESC")]
            for group in groups:
                group["receipts"] = []
                for row in connection.execute("SELECT * FROM receipts WHERE group_id=? ORDER BY page_order", (group["id"],)):
                    item = dict(row)
                    for private in ("master", "preview", "evidence"):
                        item.pop(private)
                    item["languages"] = json.loads(item["languages"])
                    item["analysis"] = run_info(current_run(connection, row))
                    group["receipts"].append(item)
                group["exports"] = [dict(row) for row in connection.execute("SELECT id,path,state,sha256,drive_id,version FROM exports WHERE group_id=?", (group["id"],))]
            jobs = [dict(row) for row in connection.execute("SELECT id,kind,target,state,attempts,error FROM jobs ORDER BY available DESC")]
        return {"groups": groups, "jobs": jobs, "drive": drive.status(),
                "analysis_defaults": {"date_order": settings.date_order, "century": settings.year_century}}

    @app.get("/api/receipts/{identity}/image")
    def image(identity: str, top: int | None = None):
        with store.transaction() as connection:
            receipt = receipt_row(connection, identity)
        if not receipt["master"]:
            fail("Image processing is not ready", 404)
        if top is None:
            return FileResponse(receipt["preview"], media_type="image/png")
        with Image.open(receipt["master"]) as master:
            if top < 0 or top >= master.height:
                fail("Row outside image", 422)
            strip = master.crop((0, top, master.width, min(top + 512, master.height)))
            buffer = io.BytesIO()
            strip.save(buffer, format="PNG")
        return Response(buffer.getvalue(), media_type="image/png", headers={"X-Image-Height": str(master.height)})

    @app.get("/api/receipts/{identity}/evidence")
    def evidence(identity: str, analysis_id: str | None = None):
        with store.transaction() as connection:
            receipt = receipt_row(connection, identity)
            capture = capture_row(connection, identity)
            run = current_run(connection, receipt)
            if analysis_id:
                run = connection.execute("SELECT * FROM analysis_runs WHERE id=? AND receipt_id=?", (analysis_id, identity)).fetchone()
                if not run or not run["evidence_path"]:
                    fail("Saved analysis is not ready", 404)
                try:
                    processing = read_evidence(run)
                except ValueError as error:
                    fail(str(error))
            else:
                processing = json.loads(receipt["evidence"]) if receipt["evidence"] else None
        return {"capture": json.loads(capture["manifest"]), "processing": processing, "analysis": run_info(run)}

    @app.get("/api/receipts/{identity}/analyses")
    def analyses(identity: str):
        with store.transaction() as connection:
            receipt_row(connection, identity)
            return {"analyses": [run_info(row) for row in connection.execute("SELECT * FROM analysis_runs WHERE receipt_id=? ORDER BY version DESC", (identity,))]}

    @app.post("/api/receipts/{identity}/analyze", status_code=202)
    def request_analysis(identity: str, body: AnalysisRequest):
        with store.transaction() as connection:
            receipt = receipt_row(connection, identity)
            group_for_edit(connection, receipt["group_id"], body.version)
            try:
                run = queue_analysis(store, connection, receipt, body)
            except ValueError as error:
                fail(str(error))
            group = store.group(connection, receipt["group_id"])
            return {"analysis": run_info(run), "group_id": group["id"], "version": group["version"]}

    @app.delete("/api/receipts/{identity}")
    def delete_receipt(identity: str, body: Version):
        with store.transaction() as connection:
            receipt = receipt_row(connection, identity)
            group = group_for_edit(connection, receipt["group_id"], body.version)
            # Even an expired lease may still have a live worker writing files.
            if processing_active(connection, identity):
                fail("Scan is still processing; retry deletion when processing finishes")
            store.changed(connection, group["id"])
            connection.execute("DELETE FROM jobs WHERE kind='process' AND target=?", (identity,))
            connection.execute("DELETE FROM jobs WHERE kind='analyze' AND target IN(SELECT id FROM analysis_runs WHERE receipt_id=?)", (identity,))
            connection.execute("DELETE FROM analysis_runs WHERE receipt_id=?", (identity,))
            connection.execute("DELETE FROM receipts WHERE id=?", (identity,))
            # Keep the capture ID as a tombstone so an upload retry cannot resurrect it.
            connection.execute("UPDATE captures SET state='deleted' WHERE id=?", (identity,))
            remaining = connection.execute("SELECT id FROM receipts WHERE group_id=? ORDER BY page_order", (group["id"],)).fetchall()
            for order, member in enumerate(remaining, 1):
                connection.execute("UPDATE receipts SET page_order=? WHERE id=?", (order, member["id"]))
            if not remaining:
                connection.execute("DELETE FROM groups WHERE id=?", (group["id"],))
            directory = settings.work / "captures" / identity
            if directory.exists():
                shutil.rmtree(directory)
                sync_directory(directory.parent)
        return {"deleted": True}

    @app.post("/api/receipts/confirm-proposed")
    def confirm_proposed(change: ConfirmProposed):
        confirmed, skipped, touched = [], [], set()
        with store.transaction() as connection:
            for identity, version in change.groups.items():
                group_for_edit(connection, identity, version)
            for identity in change.receipt_ids:
                receipt = receipt_row(connection, identity)
                if receipt["group_id"] not in change.groups:
                    fail("Page selection does not match the supplied group versions")
                if receipt["state"] != "ready":
                    skipped.append({"id": identity, "reason": "processing"}); continue
                if not receipt["date"] or not receipt["time"]:
                    skipped.append({"id": identity, "reason": "no-proposal"}); continue
                if receipt["error"]:
                    skipped.append({"id": identity, "reason": "error"}); continue
                if (current_run(connection, receipt) or {"state": "ready"})["state"] in ("queued", "running"):
                    skipped.append({"id": identity, "reason": "analysis-running"}); continue
                if not receipt["timestamp_review"]:
                    skipped.append({"id": identity, "reason": "already-confirmed"}); continue
                connection.execute("UPDATE receipts SET complete=1, readable=1, field_source='confirmed', timestamp_review=0 WHERE id=?", (identity,))
                if receipt["group_id"] not in touched:
                    store.changed(connection, receipt["group_id"]); touched.add(receipt["group_id"])
                confirmed.append({"id": identity, "group_id": receipt["group_id"]})
        return {"confirmed": len(confirmed), "skipped": skipped, "groups": sorted(touched)}

    @app.post("/api/receipts/{identity}")
    def edit(identity: str, change: Edit):
        with store.transaction() as connection:
            receipt = receipt_row(connection, identity)
            group = group_for_edit(connection, receipt["group_id"], change.version)
            if receipt["state"] != "ready":
                fail("Wait for image processing before reviewing")
            store.changed(connection, group["id"])
            if not group["manual"] and connection.execute("SELECT COUNT(*) FROM receipts WHERE group_id=?", (group["id"],)).fetchone()[0] > 1:
                new_id = str(uuid.uuid4())
                connection.execute("INSERT INTO groups(id,created) VALUES(?,?)", (new_id, time.time()))
                connection.execute("UPDATE receipts SET group_id=?,page_order=1 WHERE id=?", (new_id, identity))
            connection.execute("UPDATE receipts SET date=?,time=?,vendor=?,complete=?,readable=?,field_source='manual',timestamp_review=0 WHERE id=?",
                (change.date, change.time, change.vendor, change.complete, change.readable, identity))
            store.regroup(connection, identity)
            current = receipt_row(connection, identity)
            version = store.group(connection, current["group_id"])["version"]
        return {"saved": True, "group_id": current["group_id"], "version": version}

    @app.post("/api/groups/membership")
    def membership(change: Membership):
        if len(set(change.receipt_ids)) != len(change.receipt_ids):
            fail("Duplicate page selection", 422)
        with store.transaction() as connection:
            for identity, version in change.groups.items():
                group_for_edit(connection, identity, version)
            receipts = [receipt_row(connection, identity) for identity in change.receipt_ids]
            if {receipt["group_id"] for receipt in receipts} != set(change.groups):
                fail("Page selection does not match the supplied group versions")
            new_id = str(uuid.uuid4())
            connection.execute("INSERT INTO groups(id,manual,created) VALUES(?,1,?)", (new_id, time.time()))
            for order, receipt in enumerate(receipts, 1):
                connection.execute("UPDATE receipts SET group_id=?,page_order=? WHERE id=?", (new_id, order, receipt["id"]))
            for identity in change.groups:
                store.changed(connection, identity)
                connection.execute("UPDATE groups SET manual=1 WHERE id=?", (identity,))
                if not connection.execute("SELECT 1 FROM receipts WHERE group_id=?", (identity,)).fetchone():
                    connection.execute("DELETE FROM groups WHERE id=?", (identity,))
        return {"id": new_id}

    def approvable(connection, identity, version):
        group_for_edit(connection, identity, version)
        receipts = [dict(row) for row in connection.execute("SELECT * FROM receipts WHERE group_id=? ORDER BY page_order", (identity,))]
        if not receipts or any(r["state"] != "ready" or not r["date"] or not r["time"] or not r["complete"] or not r["readable"] for r in receipts):
            fail("Every page needs a date, time, readable master and confirmed physical bottom before approval")
        if any(receipt["timestamp_review"] for receipt in receipts):
            fail("Confirm the proposed timestamp with Save review before approval")
        if any((current_run(connection, receipt) or {"state": "ready"})["state"] in ("queued", "running") for receipt in receipts):
            fail("Wait for the current analysis before approval")
        return receipts

    @app.post("/api/groups/{identity}/prepare")
    def prepare(identity: str, body: Version):
        with store.transaction() as connection:
            receipts = approvable(connection, identity, body.version)
            existing = connection.execute("SELECT id,path,version,snapshot FROM exports WHERE group_id=? AND version=? AND state='reserved'", (identity, body.version)).fetchone()
            if existing:
                saved = dict(existing)
                saved["note"] = json.loads(saved.pop("snapshot")).get("drive_collision_note")
                return saved
        earliest = min(datetime.fromisoformat(r["date"] + "T" + r["time"]) for r in receipts)
        parent = f"{earliest.year:04d}/{earliest.month:02d}-{MONTHS[earliest.month]}"
        stem = earliest.strftime("%Y%m%d-%H%M")
        collision_note = None
        try:
            remote_names = drive.names(parent) if drive.status()["connected"] else set()
        except (ValueError, httpx.HTTPError):
            remote_names = set()
            collision_note = "Drive collision check unavailable. Local approval can continue; delivery will recheck the name."
        with store.transaction() as connection:
            receipts = approvable(connection, identity, body.version)
            index = 0
            while True:
                name = stem + (f"-{index}" if index else "") + ".pdf"
                path = parent + "/" + name
                if name not in remote_names and not (settings.archive / path).exists() and not connection.execute("SELECT 1 FROM exports WHERE path=?", (path,)).fetchone():
                    break
                index += 1
            export_id = str(uuid.uuid4())
            snapshot = {"group_id": identity, "version": body.version, "selection_reason": "earliest_transaction_timestamp",
                        "receipts": receipts, "drive_collision_note": collision_note}
            connection.execute("INSERT INTO exports(id,group_id,version,path,snapshot,created) VALUES(?,?,?,?,?,?)",
                               (export_id, identity, body.version, path, encode(snapshot), time.time()))
        return {"id": export_id, "path": path, "version": body.version, "note": collision_note}

    @app.post("/api/groups/{identity}/approve", status_code=202)
    def approve(identity: str, body: Approval):
        with store.transaction() as connection:
            export = connection.execute("SELECT * FROM exports WHERE id=? AND group_id=?", (body.export_id, identity)).fetchone()
            if not export or export["version"] != body.version:
                fail("Approval reservation changed; prepare the current group")
            group = store.group(connection, identity)
            if group["version"] == body.version and group["state"] in ("finalizing", "approved", "approval_failed"):
                return {"id": export["id"], "state": export["state"]}
            approvable(connection, identity, body.version)
            if export["state"] != "reserved":
                fail("Export is not awaiting approval")
            connection.execute("UPDATE groups SET state='finalizing' WHERE id=?", (identity,))
            connection.execute("UPDATE exports SET state='finalizing' WHERE id=?", (export["id"],))
            store.enqueue(connection, "approve", export["id"])
        return {"id": body.export_id, "state": "finalizing"}

    @app.get("/api/exports/{identity}/pdf")
    def pdf(identity: str):
        with store.transaction() as connection:
            export = connection.execute("SELECT * FROM exports WHERE id=? AND state='ready'", (identity,)).fetchone()
        if not export:
            fail("Approved PDF is not ready", 404)
        return FileResponse(settings.archive / export["path"], media_type="application/pdf", filename=Path(export["path"]).name)

    @app.post("/api/exports/{identity}/drive", status_code=202)
    def deliver(identity: str):
        if not drive.status()["connected"]:
            fail("Connect Drive before selecting delivery")
        with store.transaction() as connection:
            export = connection.execute("SELECT * FROM exports WHERE id=? AND state='ready'", (identity,)).fetchone()
            if not export:
                fail("Only approved exports can be selected for Drive delivery")
            store.enqueue(connection, "drive", identity)
        return {"queued": True}

    @app.post("/api/jobs/{identity}/retry")
    def retry(identity: str):
        with store.transaction() as connection:
            job = connection.execute("SELECT * FROM jobs WHERE id=?", (identity,)).fetchone()
            if not job or job["state"] != "failed":
                fail("Only failed jobs can be retried")
            if job["kind"] == "analyze":
                run = connection.execute("SELECT * FROM analysis_runs WHERE id=?", (job["target"],)).fetchone()
                receipt = receipt_row(connection, run["receipt_id"]) if run else None
                if not receipt or receipt["active_analysis"] != run["id"] or store.group(connection, receipt["group_id"])["state"] != "staging":
                    fail("This analysis is obsolete; use the current receipt")
                connection.execute("UPDATE analysis_runs SET state='queued',error=NULL WHERE id=?", (run["id"],))
                store.changed(connection, receipt["group_id"])
            connection.execute("UPDATE jobs SET state='pending',attempts=0,available=?,error=NULL WHERE id=?", (time.time(), identity))
        return {"queued": True}

    @app.post("/api/drive/connect")
    def connect_drive():
        nonce = secrets.token_urlsafe(32)
        try:
            url = drive.authorization(nonce)
        except ValueError as error:
            fail(str(error), 422)
        with store.transaction() as connection:
            connection.execute("DELETE FROM oauth WHERE expires<?", (time.time(),))
            connection.execute("INSERT INTO oauth VALUES(?,?)", (nonce, time.time() + 600))
        return {"url": url}

    @app.get("/api/drive/callback")
    def callback(state: str = "", code: str = ""):
        with store.transaction() as connection:
            valid = connection.execute("DELETE FROM oauth WHERE state=? AND expires>? RETURNING state", (state, time.time())).fetchone()
        if not valid or not code:
            fail("Expired or invalid Drive authorization; reconnect", 400)
        try:
            drive.exchange(code)
        except ValueError as error:
            fail(str(error), 400)
        return RedirectResponse(settings.public_url + "/", status_code=303)

    assets = ROOT / "web/build"
    driver = ROOT / "scanner-driver/build"
    if (assets / "assets").exists():
        app.mount("/assets", StaticFiles(directory=assets / "assets"), name="assets")
    if driver.exists():
        app.mount("/scanner-assets", StaticFiles(directory=driver), name="scanner-assets")

    @app.get("/raw-scanner.mjs")
    def scanner_module():
        return FileResponse(ROOT / "raw-scanner.mjs", media_type="text/javascript")

    @app.get("/")
    def index():
        if not (assets / "index.html").exists():
            return JSONResponse({"detail": "Build the UI with npm run build:app"}, status_code=503)
        return FileResponse(assets / "index.html", media_type="text/html")

    return app
