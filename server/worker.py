"""Lease-backed, restartable processing, approval and delivery jobs."""
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import uuid

import img2pdf
import numpy as np
from PIL import Image

from .drive import Drive
from .analysis_jobs import ensure_run, owns_job, read_evidence
from .binarize import RECIPES, VERSION as BINARIZE_VERSION, apply_recipe, png as recipe_png
from .enhance import enhanced_page
from .extraction import VERSION as EXTRACTOR_VERSION, dates, times
from .recognition import lines_from_tsv, recognize
from .storage import Settings, Store, digest, durable_write, encode, sync_directory

Image.MAX_IMAGE_PIXELS = 160000000

# The machine check for the legibility attestation. A receipt that OCR reads densely and confidently
# is a readable image; a sparse or shaky read is not proof of anything, so the check only ever
# attests in the positive and a human stays free to overrule it in either direction.
LEGIBLE_MIN_CHARACTERS = 60
LEGIBLE_MIN_CONFIDENCE = 70.0  # Tesseract's 0-100 word scale, double the weak_ocr_evidence cutoff


def assess_legibility(evidence):
    """Return measurement stats when the saved recognition evidence proves a legible page, else None.
    Lines that multiple passes read at the same text collapse to their best confidence, so a second
    pass cannot double-count characters, and confidence is weighted by characters per line."""
    best = {}
    for line in (evidence.get("ocr") or {}).get("lines") or []:
        text = (line.get("text") or "").strip()
        if len(text) > 1:
            best[text] = max(best.get(text, 0.0), float(line.get("confidence") or 0.0))
    characters = sum(len(text) for text in best)
    if characters < LEGIBLE_MIN_CHARACTERS:
        return None
    weighted = sum(confidence * len(text) for text, confidence in best.items()) / characters
    return {"characters": characters, "confidence": round(weighted, 2)} if weighted >= LEGIBLE_MIN_CONFIDENCE else None


def image_bytes(image, format, **kwargs):
    buffer = io.BytesIO()
    image.save(buffer, format=format, **kwargs)
    return buffer.getvalue()


def process(store, identity, ocr_backend=None, fallback=None, job=None):
    settings = store.settings
    with store.transaction() as connection:
        row = connection.execute("SELECT * FROM captures WHERE id=?", (identity,)).fetchone()
        manifest = json.loads(row["manifest"])
        receipt = connection.execute("SELECT * FROM receipts WHERE id=?", (identity,)).fetchone()
        if receipt["state"] == "ready":
            if digest(receipt["master"]) != json.loads(receipt["evidence"])["master_sha256"]:
                raise ValueError("Previously committed master checksum failed")
            return  # Recovered lease after commit, possibly after approved cleanup.
        if not owns_job(connection, job):
            return
        run = ensure_run(store, connection, receipt)
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
    image.close()
    with store.transaction() as connection:
        if not owns_job(connection, job):
            return
        connection.execute("UPDATE receipts SET master=?,preview=?,evidence=? WHERE id=?", (str(master), str(preview), encode(evidence), identity))
    analyze(store, run["id"], ocr_backend, fallback, job)


def stamp_region(evidence):
    """The printed timestamp region a binarization ranking should measure, in master pixels:
    the union of the source lines behind the proposed (or first) timestamp candidate."""
    extraction = evidence.get("extraction") or {}
    candidates = extraction.get("candidates") or []
    if not candidates:
        return None
    selected = extraction.get("selected") or {}
    chosen = next((candidate for candidate in candidates if candidate.get("id") == selected.get("candidate_id")), candidates[0])
    boxes = [source["box"] for source in chosen.get("sources", []) if len(source.get("box") or ()) == 4]
    if not boxes:
        return None
    return [min(box[0] for box in boxes), min(box[1] for box in boxes),
            max(box[2] for box in boxes), max(box[3] for box in boxes)]


def rank_binarization(receipt, capture, evidence, policy):
    """RA-11: read this page's printed timestamp region once per recipe and score the reads, so
    the operator can see which processing surfaced the stamp and choose it. The date and time
    readers run under the page pass's own policy - two-digit years and numeric order only resolve
    with the century and month the analysis was actually given. It measures only: no timestamp,
    legibility or field anywhere is written from these numbers."""
    region = stamp_region(evidence)
    if not region:
        return None
    with Image.open(receipt["master"]) as master:
        master = master.convert("L")
        margin = max(6, (region[3] - region[1]) // 3)  # stamps are often clipped by their own candidate box
        region = (max(0, region[0] - margin), max(0, region[1] - margin),
                  min(master.width, region[2] + margin), min(master.height, region[3] + margin))
        gray = np.asarray(master.crop(region), dtype=np.uint8)
    if gray.shape[1] < 24 or gray.shape[0] < 12:
        return None
    profile = [language for language in capture["languages"] if language in ("eng", "fra", "jpn", "chi_tra", "chi_sim")] or ["eng"]
    effective = policy["effective"]
    results = []
    for key, recipe in RECIPES.items():  # reference is listed first; a stable sort keeps it first on exact ties
        pixels = recipe_png(apply_recipe(key, gray))
        process = subprocess.run(["tesseract", "stdin", "stdout", "--dpi", "200", "-l", "+".join(profile),
                                  "--psm", "6", "tsv"], input=pixels, capture_output=True, timeout=20,
                                 env={**os.environ, "OMP_THREAD_LIMIT": "2"})
        if process.returncode:
            raise ValueError(f"binarization read failed: {process.stderr.decode('utf-8', 'replace')[:200]}")
        lines = lines_from_tsv(process.stdout.decode("utf-8", "replace"), f"binarize-{key}")
        characters = sum(len(line.text) for line in lines)
        weighted = sum(line.confidence * len(line.text) for line in lines) / characters if characters else 0.0
        date_values, time_values = [], []
        for line in lines:
            found_dates = dates(line.text, order=effective["date_order"], century=effective["century"],
                                expected_month=effective.get("expected_month"))
            date_values.extend(value for item in found_dates for value in item["values"])
            time_values.extend(item["value"] for item in times(line.text, [item["span"] for item in found_dates]) if item["value"])
        results.append({"key": key, "label": recipe["label"], "sha256": hashlib.sha256(pixels).hexdigest(),
                        "characters": characters, "confidence": round(weighted, 2),
                        "timestamp_read": {"date": date_values[0] if date_values else None,
                                           "time": time_values[0] if time_values else None}})
    results.sort(key=lambda item: (
        item["timestamp_read"]["date"] is None or item["timestamp_read"]["time"] is None,
        item["timestamp_read"]["date"] is None and item["timestamp_read"]["time"] is None,
        -item["confidence"], -item["characters"]))
    return {"version": BINARIZE_VERSION, "region": [int(value) for value in region],
            "results": results, "selected": results[0]["key"]}


def analyze(store, run_id, ocr_backend=None, fallback=None, job=None):
    with store.transaction() as connection:
        run = connection.execute("SELECT * FROM analysis_runs WHERE id=?", (run_id,)).fetchone()
        if not run or not owns_job(connection, job):
            return
        if run["state"] == "ready":
            read_evidence(run)
            return
        receipt = connection.execute("SELECT * FROM receipts WHERE id=?", (run["receipt_id"],)).fetchone()
        if not receipt or receipt["active_analysis"] != run_id:
            connection.execute("UPDATE analysis_runs SET state='superseded' WHERE id=?", (run_id,))
            return
        capture = json.loads(connection.execute("SELECT manifest FROM captures WHERE id=?", (receipt["id"],)).fetchone()[0])
        connection.execute("UPDATE analysis_runs SET state='running',error=NULL WHERE id=?", (run_id,))
        base = connection.execute("SELECT * FROM analysis_runs WHERE id=?", (run["base_id"],)).fetchone() if run["base_id"] else None
    policy = json.loads(run["policy"])
    if run["mode"] == "ocr" and run["base_id"] and not store.settings.ocr:
        raise ValueError("OCR was disabled before this recognition run; keep the prior evidence or enable OCR and retry")
    master_sha = json.loads(receipt["evidence"])["master_sha256"]
    if digest(receipt["master"]) != master_sha:
        raise ValueError("Reference master checksum failed before analysis")
    root = store.settings.work / "captures" / receipt["id"] / "analyses" / run_id
    output = root / (job["owner"] if job else str(uuid.uuid4()))
    evidence, path = None, None
    for candidate in sorted(root.glob("*/evidence.json")):
        marker = candidate.with_suffix(".sha256")
        if not marker.exists() or digest(candidate) != marker.read_text():
            continue
        saved = json.loads(candidate.read_text())
        metadata = saved.get("analysis", {})
        if metadata.get("id") == run_id and metadata.get("policy") == policy and metadata.get("extractor") == EXTRACTOR_VERSION and metadata.get("binarization") == BINARIZE_VERSION and saved.get("master_sha256") == master_sha:
            evidence, path = saved, candidate
            break
    if evidence is None:
        evidence = {"master_sha256": master_sha, "master_kind": "lossless_reference_v1", "date_time_source": "manual_review_required", "ocr": None}
        if run["mode"] == "parse":
            from .reanalysis import reparse_ocr
            prior = read_evidence(base)
            evidence["ocr"] = reparse_ocr(prior["ocr"], policy["effective"])
            if prior.get("binarization"):
                evidence["binarization"] = prior["binarization"]  # a re-parse must not quietly drop the measured reads
        elif store.settings.ocr:
            ocr_started = time.monotonic()
            with Image.open(receipt["master"]) as image:
                evidence["ocr"] = recognize(image, dpi=capture["dpi_y"], languages=capture["languages"], output=output / "ocr",
                                             date_order=policy["effective"]["date_order"], century=policy["effective"]["century"],
                                             expected_month=policy["effective"].get("expected_month"), backend=ocr_backend)
            if fallback is not None:
                from .ocr_pipeline import route
                evidence["ocr"] = route(evidence["ocr"], fallback, receipt["master"], output=output / "ocr" / "fallback",
                                         dpi=capture["dpi_y"], languages=capture["languages"],
                                         date_order=policy["effective"]["date_order"], century=policy["effective"]["century"],
                                         expected_month=policy["effective"].get("expected_month"))
            evidence["ocr"]["seconds"] = round(time.monotonic() - ocr_started, 6)
        if evidence["ocr"] is not None:
            evidence["extraction"] = evidence["ocr"].pop("extraction")
            evidence["date_time_source"] = evidence["extraction"]["version"]
            if run["mode"] == "ocr":
                try:
                    ranking = rank_binarization(receipt, capture, evidence, policy)
                except Exception as error:
                    # The ranking is a convenience for the operator; it must never fail the analysis.
                    evidence["binarization_error"] = str(error)[:300]
                    ranking = None
                if ranking:
                    evidence["binarization"] = ranking
        evidence["analysis"] = {"id": run_id, "version": run["version"], "mode": run["mode"], "policy": policy,
                                "extractor": EXTRACTOR_VERSION, "binarization": BINARIZE_VERSION}
        path = output / "evidence.json"
        durable_write(path, encode(evidence).encode())
        durable_write(path.with_suffix(".sha256"), digest(path).encode())
    with store.transaction() as connection:
        if not owns_job(connection, job):
            return
        receipt = connection.execute("SELECT * FROM receipts WHERE id=?", (run["receipt_id"],)).fetchone()
        active = receipt and receipt["active_analysis"] == run_id and receipt["analysis_version"] == run["version"] and store.group(connection, receipt["group_id"])["state"] == "staging"
        connection.execute("UPDATE analysis_runs SET state=?,evidence_path=?,evidence_sha256=?,error=NULL WHERE id=?",
                           ("ready" if active else "superseded", str(path), digest(path), run_id))
        if active:
            selected = (evidence.get("extraction") or {}).get("selected")
            manual = receipt["field_source"] == "manual"
            if receipt["readable_source"] == "operator":
                # A human already judged legibility, in either direction; a machine may not reopen that.
                readable, readable_source = receipt["readable"], "operator"
            else:
                legible = assess_legibility(evidence)
                readable, readable_source = int(legible is not None), "ocr" if legible else None
            connection.execute("""UPDATE receipts SET state='ready',master=?,preview=?,evidence=?,error=NULL,
              date=?,time=?,field_source=?,timestamp_review=?,readable=?,readable_source=? WHERE id=?""",
              (receipt["master"], receipt["preview"], encode(evidence), receipt["date"] if manual else selected["date"] if selected else None,
               receipt["time"] if manual else selected["time"] if selected else None,
               "manual" if manual else "ocr" if selected else "unresolved", 0 if manual else 1,
               readable, readable_source, receipt["id"]))
            store.changed(connection, receipt["group_id"])
            if selected and not manual:
                store.regroup(connection, receipt["id"])


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
        enhanced = []
        for receipt in snapshot["receipts"]:
            source = Path(receipt["master"])
            expected = json.loads(receipt["evidence"])["master_sha256"]
            if digest(source) != expected:
                raise ValueError("Selected master checksum failed; staging retained")
            target = directory / f"{receipt['id']}.tiff"
            durable_write(target, source.read_bytes())
            masters.append({"receipt_id": receipt["id"], "path": str(target), "sha256": expected})
            page = directory / f"{receipt['id']}-enhanced.tif"
            durable_write(page, enhanced_page(source, recipe=receipt.get("page_recipe") or "sauvola"))
            enhanced.append({"receipt_id": receipt["id"], "path": str(page), "sha256": digest(page)})
            pages.append(str(page))
        pdf = img2pdf.convert(pages)
        durable_write(document, pdf)
        checksum = digest(document)
        manifest = {"id": identity, "path": export["path"], "sha256": checksum,
                    "snapshot": snapshot, "masters": masters, "enhanced": enhanced}
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


def run_one(store, drive=None, ocr_backend=None, fallback=None):
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
            process(store, job["target"], ocr_backend, fallback, job)
        elif job["kind"] == "analyze":
            analyze(store, job["target"], ocr_backend, fallback, job)
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
            if not owns_job(connection, job):
                return True
            connection.execute("UPDATE jobs SET state=?,error=?,available=?,lease_until=NULL WHERE id=? AND owner=?",
                ("pending" if retry else "failed", message, time.time() + 2 ** job["attempts"], job["id"], job["owner"]))
            if not retry and job["kind"] == "process":
                connection.execute("UPDATE receipts SET state='failed',error=? WHERE id=?", (message, job["target"]))
                connection.execute("UPDATE analysis_runs SET state='failed',error=? WHERE id=(SELECT active_analysis FROM receipts WHERE id=?)", (message, job["target"]))
            if not retry and job["kind"] == "analyze":
                connection.execute("UPDATE analysis_runs SET state='failed',error=? WHERE id=? AND state<>'superseded'", (message, job["target"]))
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
    fallback = None
    if store.settings.ocr and store.settings.ocr_fallback == "rapidocr":
        from .ocr_fallback import FallbackClient
        fallback = FallbackClient(models=os.getenv("RAPIDOCR_MODEL_DIR", "/opt/receipt-ocr-models"),
                                  timeout=store.settings.fallback_timeout, memory_mib=store.settings.fallback_memory_mib)
    last_heartbeat = 0
    try:
        while not stop.is_set():
            if time.time() - last_heartbeat > 10:
                durable_write(store.settings.state / "worker-heartbeat", str(time.time()).encode())
                last_heartbeat = time.time()
            if not run_one(store, drive, backend, fallback):
                stop.wait(1)
    finally:
        if fallback:
            fallback.close()
        if backend:
            backend.close()


if __name__ == "__main__":
    main()
