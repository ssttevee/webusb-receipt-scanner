"""SQLite transactions and same-filesystem durable file finalization."""
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import uuid


@dataclass
class Settings:
    state: Path
    work: Path
    archive: Path
    public_url: str = "http://localhost:8000"
    ocr: bool = True
    lease_seconds: int = 300

    @classmethod
    def environment(cls):
        return cls(Path(os.getenv("STATE_DIR", "/state")), Path(os.getenv("WORK_DIR", "/work")),
                   Path(os.getenv("ARCHIVE_DIR", "/archive")), os.getenv("APP_PUBLIC_URL", "http://localhost:8000").rstrip("/"),
                   os.getenv("OCR_ENABLED", "1") == "1")


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def ensure_directory(path):
    path = Path(path)
    if not path.exists():
        ensure_directory(path.parent)
        path.mkdir(exist_ok=True)
        sync_directory(path.parent)


def durable_write(path, data, replace=True):
    path = Path(path)
    ensure_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
            os.unlink(temporary)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


SCHEMA = """
CREATE TABLE captures(id TEXT PRIMARY KEY, manifest TEXT NOT NULL, state TEXT NOT NULL,
 created REAL NOT NULL);
CREATE TABLE groups(id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL DEFAULT 'staging', manual INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
CREATE TABLE receipts(id TEXT PRIMARY KEY REFERENCES captures(id), group_id TEXT NOT NULL REFERENCES groups(id),
 page_order INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'queued',
 date TEXT, time TEXT, vendor TEXT, complete INTEGER NOT NULL DEFAULT 0,
 readable INTEGER NOT NULL DEFAULT 0, languages TEXT NOT NULL DEFAULT '["eng"]',
 master TEXT, preview TEXT, evidence TEXT, error TEXT, created REAL NOT NULL);
CREATE TABLE exports(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
 version INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'reserved', sha256 TEXT, drive_id TEXT, created REAL NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 available REAL NOT NULL, lease_until REAL, owner TEXT, error TEXT,
 UNIQUE(kind,target));
CREATE TABLE oauth(state TEXT PRIMARY KEY, expires REAL NOT NULL);
CREATE INDEX receipt_group ON receipts(group_id, page_order);
CREATE INDEX job_queue ON jobs(state, available, lease_until);
PRAGMA user_version=1;
"""


class Store:
    def __init__(self, settings):
        self.settings = settings
        for path in (settings.state, settings.work, settings.archive):
            path.mkdir(parents=True, exist_ok=True)
        self.database = settings.state / "receipts.sqlite3"
        with self.transaction() as connection:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                connection.executescript("BEGIN IMMEDIATE;" + SCHEMA + "COMMIT;")
            elif version != 1:
                raise RuntimeError("Unsupported database schema; use the matching application version")
        os.chmod(self.database, 0o600)

    @contextmanager
    def transaction(self):
        connection = sqlite3.connect(self.database, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
            if connection.in_transaction:
                connection.commit()
        except BaseException:
            if connection.in_transaction:
                connection.rollback()
            raise
        finally:
            connection.close()

    def enqueue(self, connection, kind, target):
        connection.execute("INSERT OR IGNORE INTO jobs(id,kind,target,available) VALUES(?,?,?,?)",
                           (str(uuid.uuid4()), kind, target, time.time()))

    def claim(self):
        now = time.time()
        with self.transaction() as connection:
            job = connection.execute("""SELECT * FROM jobs WHERE
              (state='pending' AND available<=?) OR (state='running' AND lease_until<?)
              ORDER BY available LIMIT 1""", (now, now)).fetchone()
            if not job:
                return None
            owner = str(uuid.uuid4())
            connection.execute("UPDATE jobs SET state='running',owner=?,lease_until=?,attempts=attempts+1 WHERE id=?",
                               (owner, now + self.settings.lease_seconds, job["id"]))
            return dict(connection.execute("SELECT * FROM jobs WHERE id=?", (job["id"],)).fetchone())

    def group(self, connection, identity):
        group = connection.execute("SELECT * FROM groups WHERE id=?", (identity,)).fetchone()
        if not group:
            raise LookupError("Group not found")
        return dict(group)

    def changed(self, connection, identity):
        connection.execute("UPDATE groups SET version=version+1 WHERE id=?", (identity,))
        connection.execute("DELETE FROM exports WHERE group_id=? AND state='reserved'", (identity,))

    def regroup(self, connection, receipt_id):
        receipt = connection.execute("SELECT * FROM receipts WHERE id=?", (receipt_id,)).fetchone()
        group = self.group(connection, receipt["group_id"])
        if group["manual"] or not receipt["date"] or not receipt["time"]:
            return
        matches = connection.execute("""SELECT DISTINCT g.id FROM groups g JOIN receipts r ON r.group_id=g.id
          WHERE g.state='staging' AND g.manual=0 AND g.id<>? AND r.date=? AND substr(r.time,1,5)=?
          ORDER BY g.created""", (group["id"], receipt["date"], receipt["time"][:5])).fetchall()
        source = connection.execute("SELECT * FROM receipts WHERE group_id=?", (group["id"],)).fetchall()
        key = (receipt["date"], receipt["time"][:5])
        for match in matches:
            target = connection.execute("SELECT * FROM receipts WHERE group_id=? ORDER BY page_order", (match["id"],)).fetchall()
            combined = [*target, *source]
            vendors = {r["vendor"].casefold().strip() for r in combined if r["vendor"]}
            if len(vendors) > 1 or any((r["date"], (r["time"] or "")[:5]) != key for r in combined):
                continue
            for order, member in enumerate(combined, 1):
                connection.execute("UPDATE receipts SET group_id=?,page_order=? WHERE id=?", (match["id"], order, member["id"]))
            self.changed(connection, match["id"])
            connection.execute("DELETE FROM exports WHERE group_id=? AND state='reserved'", (group["id"],))
            connection.execute("DELETE FROM groups WHERE id=?", (group["id"],))
            return
