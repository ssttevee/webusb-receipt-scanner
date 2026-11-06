"""Lease-backed, restartable processing, approval and delivery jobs."""
import io
import json
import os
from pathlib import Path
import signal
import threading
import time

import img2pdf
import numpy as np
from PIL import Image

from .drive import Drive
from .recognition import recognize
from .storage import Settings, Store, digest, durable_write, encode, sync_directory

Image.MAX_IMAGE_PIXELS = 160000000


def image_bytes(image, format, **kwargs):
    buffer = io.BytesIO()
    image.save(buffer, format=format, **kwargs)
    return buffer.getvalue()


def process(store, identity, ocr_backend=None):
    settings = store.settings
    with store.transaction() as connection:
        row = connection.execute("SELECT * FROM captures WHERE id=?", (identity,)).fetchone()
        manifest = json.loads(row["manifest"])
        receipt = connection.execute("SELECT * FROM receipts WHERE id=?", (identity,)).fetchone()
        if receipt["state"] == "ready":
            if digest(receipt["master"]) != json.loads(receipt["evidence"])["master_sha256"]:
                raise ValueError("Previously committed master checksum failed")
            return  # Recovered lease after commit, possibly after approved cleanup.
    directory = settings.work / "captures" / identity
    original = directory / "original.bin"
    if digest(original) != manifest["sha256"]:
        raise ValueError("Stored original checksum failed")
    if manifest["kind"] == "scanner-raw":
        frame = manifest["frame"]
        rows = np.fromfile(original, dtype=np.uint8).reshape(manifest["height"], frame["bytes_per_line"])
        channels = 3 if frame["format"] == 1 else 1
        pixels = rows[:, :manifest["width"] * channels]
        shape = (manifest["height"], manifest["width"], 3) if channels == 3 else (manifest["height"], manifest["width"])
        image = Image.fromarray(pixels.reshape(shape).copy())
    else:
        with Image.open(original) as opened:
            if opened.format not in ("PNG", "TIFF") or getattr(opened, "n_frames", 1) != 1:
                raise ValueError("Import one unprocessed PNG/TIFF image per capture")
            if opened.size != (manifest["width"], manifest["height"]):
                raise ValueError("Imported image dimensions differ from manifest")
            if opened.mode not in ("1", "L", "RGB", "RGBA") or (opened.mode == "RGBA" and opened.getchannel("A").getextrema() != (255, 255)):
                raise ValueError("Import an opaque 8-bit RGB/grayscale PNG or TIFF")
            image = opened.convert("RGB")
    master = directory / "master.tiff"
    durable_write(master, image_bytes(image, "TIFF", compression="tiff_deflate", dpi=(manifest["dpi_x"], manifest["dpi_y"])))
    preview = directory / "preview.png"
    thumbnail = image.copy()
    thumbnail.thumbnail((800, 1600))
    durable_write(preview, image_bytes(thumbnail, "PNG"))
    evidence = {"master_sha256": digest(master), "master_kind": "lossless_reference_v1",
                "date_time_source": "manual_review_required", "ocr": None}
    if settings.ocr:
        evidence["ocr"] = recognize(image, dpi=manifest["dpi_y"], languages=manifest["languages"], output=directory / "ocr",
                                    date_order=settings.date_order, century=settings.year_century, backend=ocr_backend)
        evidence["extraction"] = evidence["ocr"].pop("extraction")
        evidence["date_time_source"] = evidence["extraction"]["version"]
    image.close()
    durable_write(directory / "evidence.json", encode(evidence).encode())
    with store.transaction() as connection:
        # A stale retry must not invalidate manual edits to an already-ready receipt.
        receipt = connection.execute("SELECT * FROM receipts WHERE id=?", (identity,)).fetchone()
        if receipt["state"] != "ready":
            selected = (evidence.get("extraction") or {}).get("selected")
            manual = receipt["field_source"] == "manual"
            connection.execute("""UPDATE receipts SET state='ready',master=?,preview=?,evidence=?,error=NULL,
              date=?,time=?,field_source=?,timestamp_review=? WHERE id=?""",
              (str(master), str(preview), encode(evidence), receipt["date"] if manual else selected["date"] if selected else None,
               receipt["time"] if manual else selected["time"] if selected else None,
               "manual" if manual else "ocr" if selected else "unresolved", 0 if manual else 1, identity))
            store.changed(connection, receipt["group_id"])
            if selected and not manual:
                store.regroup(connection, identity)


def finalize_export(store, identity):
    settings = store.settings
    with store.transaction() as connection:
        export = dict(connection.execute("SELECT * FROM exports WHERE id=?", (identity,)).fetchone())
        if export["state"] == "ready":
            return
        group = store.group(connection, export["group_id"])
        if group["version"] != export["version"] or group["state"] not in ("finalizing", "approval_failed"):
            raise ValueError("Approval version no longer matches staged data")
    snapshot = json.loads(export["snapshot"])
    directory = settings.archive / ".exports" / identity
    document = directory / "document.pdf"
    manifest_path = directory / "manifest.json"
    if manifest_path.exists():
        # PDF generators may emit timestamps/random IDs. Reuse the durable bytes
        # after a crash between filesystem finalization and database commit.
        manifest = json.loads(manifest_path.read_text())
        if manifest["snapshot"] != snapshot or manifest["id"] != identity or digest(document) != manifest["sha256"]:
            raise ValueError("Interrupted export artifacts do not match the reserved approval")
        for master in manifest["masters"]:
            if digest(master["path"]) != master["sha256"]:
                raise ValueError("Interrupted export master checksum failed")
        masters, checksum, pdf = manifest["masters"], manifest["sha256"], document.read_bytes()
    else:
        masters = []
        pages = []
        for receipt in snapshot["receipts"]:
            source = Path(receipt["master"])
            expected = json.loads(receipt["evidence"])["master_sha256"]
            if digest(source) != expected:
                raise ValueError("Selected master checksum failed; staging retained")
            target = directory / f"{receipt['id']}.tiff"
            durable_write(target, source.read_bytes())
            masters.append({"receipt_id": receipt["id"], "path": str(target), "sha256": expected})
            pages.append(str(target))
        pdf = img2pdf.convert(pages)
        durable_write(document, pdf)
        checksum = digest(document)
        manifest = {"id": identity, "path": export["path"], "sha256": checksum,
                    "snapshot": snapshot, "masters": masters}
        durable_write(manifest_path, encode(manifest).encode())
    destination = settings.archive / export["path"]
    try:
        durable_write(destination, pdf, replace=False)
    except FileExistsError:
        if digest(destination) != checksum:
            raise ValueError("Reserved archive path is occupied; existing artifact was preserved") from None
    if digest(destination) != checksum:
        raise ValueError("Final PDF checksum failed")
    with store.transaction() as connection:
        current = store.group(connection, export["group_id"])
        if current["version"] != export["version"]:
            raise ValueError("Stale approval cannot commit")
        connection.execute("UPDATE exports SET state='ready',sha256=? WHERE id=?", (checksum, identity))
        connection.execute("UPDATE groups SET state='approved' WHERE id=?", (export["group_id"],))
        for master in masters:
            connection.execute("UPDATE receipts SET master=? WHERE id=?", (master["path"], master["receipt_id"]))
        store.enqueue(connection, "cleanup", identity)


def cleanup(store, identity):
    with store.transaction() as connection:
        export = dict(connection.execute("SELECT * FROM exports WHERE id=?", (identity,)).fetchone())
    if export["state"] != "ready" or digest(store.settings.archive / export["path"]) != export["sha256"]:
        raise ValueError("Cleanup blocked: approved PDF is not durable")
    manifest = json.loads((store.settings.archive / ".exports" / identity / "manifest.json").read_text())
    for master in manifest["masters"]:
        if digest(master["path"]) != master["sha256"]:
            raise ValueError("Cleanup blocked: approved master is not durable")
    for receipt in manifest["snapshot"]["receipts"]:
        directory = store.settings.work / "captures" / receipt["id"]
        # Private sample ZIPs live elsewhere and are never touched by this cleanup.
        for path in [directory / "original.bin", directory / "master.tiff", *directory.glob("chunk-*.bin")]:
            path.unlink(missing_ok=True)
        if directory.exists():
            sync_directory(directory)


def run_one(store, drive=None, ocr_backend=None):
    job = store.claim()
    if not job:
        return False
    stop = threading.Event()

    def heartbeat():
        while not stop.wait(max(0.1, store.settings.lease_seconds / 3)):
            with store.transaction() as connection:
                connection.execute("UPDATE jobs SET lease_until=? WHERE id=? AND owner=? AND state='running'",
                    (time.time() + store.settings.lease_seconds, job["id"], job["owner"]))
            durable_write(store.settings.state / "worker-heartbeat", str(time.time()).encode())

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        if job["kind"] == "process":
            process(store, job["target"], ocr_backend)
        elif job["kind"] == "approve":
            finalize_export(store, job["target"])
        elif job["kind"] == "cleanup":
            cleanup(store, job["target"])
        elif job["kind"] == "drive":
            with store.transaction() as connection:
                export = dict(connection.execute("SELECT * FROM exports WHERE id=?", (job["target"],)).fetchone())
            if export["state"] != "ready" or digest(store.settings.archive / export["path"]) != export["sha256"]:
                raise ValueError("Only durable approved PDFs can be delivered")
            remote = (drive or Drive(store.settings)).upload(export)
            with store.transaction() as connection:
                connection.execute("UPDATE exports SET drive_id=? WHERE id=?", (remote, export["id"]))
        else:
            raise ValueError("Unknown job kind")
        with store.transaction() as connection:
            connection.execute("UPDATE jobs SET state='done',lease_until=NULL,error=NULL WHERE id=? AND owner=?", (job["id"], job["owner"]))
    except Exception as error:
        # Public error codes avoid leaking OCR, request bodies or provider tokens.
        message = str(error) if isinstance(error, ValueError) else "Processing failed; retained data can be retried"
        retry = job["attempts"] < 3
        with store.transaction() as connection:
            connection.execute("UPDATE jobs SET state=?,error=?,available=?,lease_until=NULL WHERE id=? AND owner=?",
                ("pending" if retry else "failed", message, time.time() + 2 ** job["attempts"], job["id"], job["owner"]))
            if not retry and job["kind"] == "process":
                connection.execute("UPDATE receipts SET state='failed',error=? WHERE id=?", (message, job["target"]))
            if not retry and job["kind"] == "approve":
                connection.execute("UPDATE groups SET state='approval_failed' WHERE id=(SELECT group_id FROM exports WHERE id=?)", (job["target"],))
    finally:
        stop.set()
        thread.join()
    return True


def main():
    store = Store(Settings.environment())
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    drive = Drive(store.settings)
    backend = None
    if store.settings.ocr and store.settings.ocr_backend == "tesserocr":
        from .ocr_backends import TesseractAPI
        backend = TesseractAPI(tessdata=os.getenv("TESSDATA_PREFIX", "/usr/share/tesseract-ocr/5/tessdata"))
    last_heartbeat = 0
    try:
        while not stop.is_set():
            if time.time() - last_heartbeat > 10:
                durable_write(store.settings.state / "worker-heartbeat", str(time.time()).encode())
                last_heartbeat = time.time()
            if not run_one(store, drive, backend):
                stop.wait(1)
    finally:
        if backend:
            backend.close()


if __name__ == "__main__":
    main()
