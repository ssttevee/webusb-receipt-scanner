"""Immutable analysis snapshots and receipt-local policy requests."""
import json
from pathlib import Path
import time
import uuid

from .storage import digest, durable_write, encode


def policy_snapshot(settings, date_order="inherit", century="inherit", source="application"):
    return {"requested": {"date_order": date_order, "century": century},
            "effective": {"date_order": settings.date_order if date_order == "inherit" else date_order,
                          "century": settings.year_century if century == "inherit" else century},
            "scope": "receipt", "source": source}


def run_info(row):
    if not row:
        return None
    return {**{key: json.loads(row[key]) if key == "policy" else row[key]
               for key in ("id", "version", "mode", "policy", "state", "error", "created")},
            "has_evidence": row["evidence_path"] is not None}


def current_run(connection, receipt):
    return connection.execute("SELECT * FROM analysis_runs WHERE id=?", (receipt["active_analysis"],)).fetchone() if receipt["active_analysis"] else None


def owns_job(connection, job):
    return job is None or connection.execute("SELECT 1 FROM jobs WHERE id=? AND owner=? AND state='running'", (job["id"], job["owner"])).fetchone() is not None


def read_evidence(run):
    try:
        valid = run and run["evidence_path"] and digest(run["evidence_path"]) == run["evidence_sha256"]
    except OSError:
        valid = False
    if not valid:
        raise ValueError("Saved analysis evidence is missing or has a different checksum")
    return json.loads(Path(run["evidence_path"]).read_text())


def ensure_run(store, connection, receipt):
    existing = current_run(connection, receipt)
    if existing:
        return existing
    identity = str(uuid.uuid4())
    version = receipt["analysis_version"] + 1
    policy = policy_snapshot(store.settings)
    manifest = json.loads(connection.execute("SELECT manifest FROM captures WHERE id=?", (receipt["id"],)).fetchone()[0])
    if manifest.get("timestamp_policy") is not None:
        policy = policy_snapshot(store.settings, century=manifest["timestamp_policy"]["century"], source="scan_settings")
    mode, state = "ocr", "queued"
    path, checksum = None, None
    if receipt["evidence"] and receipt["state"] == "ready":
        # Preserve pre-history receipts before their first explicit reanalysis.
        evidence = json.loads(receipt["evidence"])
        previous = (evidence.get("extraction") or {}).get("policy", {})
        policy["effective"] = {"date_order": previous.get("date_order"), "century": previous.get("two_digit_year_century")}
        policy["source"] = "legacy_snapshot"
        evidence["analysis"] = {"id": identity, "version": version, "policy": policy, "mode": "legacy"}
        path = store.settings.work / "captures" / receipt["id"] / "analyses" / identity / "legacy.json"
        durable_write(path, encode(evidence).encode())
        checksum, mode, state = digest(path), "legacy", "ready"
        connection.execute("UPDATE receipts SET evidence=? WHERE id=?", (encode(evidence), receipt["id"]))
    connection.execute("""INSERT INTO analysis_runs(id,receipt_id,version,mode,policy,state,evidence_path,evidence_sha256,created)
      VALUES(?,?,?,?,?,?,?,?,?)""", (identity, receipt["id"], version, mode, encode(policy), state, str(path) if path else None, checksum, time.time()))
    connection.execute("UPDATE receipts SET active_analysis=?,analysis_version=? WHERE id=?", (identity, version, receipt["id"]))
    return connection.execute("SELECT * FROM analysis_runs WHERE id=?", (identity,)).fetchone()


def queue_analysis(store, connection, receipt, request):
    if receipt["state"] != "ready" or not receipt["master"]:
        raise ValueError("Wait for a readable reference master before reanalysis")
    if connection.execute("SELECT 1 FROM jobs WHERE kind='process' AND target=? AND state='running'", (receipt["id"],)).fetchone():
        raise ValueError("Initial processing is still active; retry after it finishes")
    evidence = json.loads(receipt["evidence"])
    if request.mode == "parse" and not (evidence.get("ocr") or {}).get("lines"):
        raise ValueError("No saved OCR lines; run OCR again")
    if request.mode == "ocr" and not store.settings.ocr:
        raise ValueError("Enable OCR before a fresh recognition run")
    previous = ensure_run(store, connection, receipt)
    base_id = previous["id"] if previous["state"] == "ready" else evidence.get("analysis", {}).get("id")
    if request.mode == "parse" and not base_id:
        raise ValueError("No complete saved analysis to reparse")
    if previous["state"] in ("queued", "running", "failed"):
        connection.execute("UPDATE analysis_runs SET state='superseded' WHERE id=?", (previous["id"],))
        connection.execute("UPDATE jobs SET state='done',error='superseded' WHERE kind='analyze' AND target=? AND state='pending'", (previous["id"],))
    identity, version = str(uuid.uuid4()), previous["version"] + 1
    policy = policy_snapshot(store.settings, request.date_order, request.century, "user_receipt_override")
    connection.execute("""INSERT INTO analysis_runs(id,receipt_id,version,mode,policy,state,base_id,created)
      VALUES(?,?,?,?,?,'queued',?,?)""", (identity, receipt["id"], version, request.mode, encode(policy), base_id, time.time()))
    connection.execute("""UPDATE receipts SET active_analysis=?,analysis_version=?,
      date=CASE WHEN field_source='manual' THEN date ELSE NULL END,
      time=CASE WHEN field_source='manual' THEN time ELSE NULL END,
      timestamp_review=CASE WHEN field_source='manual' THEN timestamp_review ELSE 1 END WHERE id=?""", (identity, version, receipt["id"]))
    store.changed(connection, receipt["group_id"])
    store.enqueue(connection, "analyze", identity)
    return connection.execute("SELECT * FROM analysis_runs WHERE id=?", (identity,)).fetchone()


def processing_active(connection, identity):
    return connection.execute("""SELECT 1 FROM jobs WHERE state='running' AND
      ((kind='process' AND target=?) OR (kind='analyze' AND target IN(SELECT id FROM analysis_runs WHERE receipt_id=?)))""", (identity, identity)).fetchone() is not None
