"""Durable outbox and authenticated HTTPS transport shared by desktop collectors."""
from contextlib import contextmanager
import hashlib
import hmac
import http.client
import json
from pathlib import Path
import sqlite3
import ssl
from urllib.parse import urlparse
from uuid import uuid4
from datetime import datetime


def load_config(path):
    config = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    parsed = urlparse(config.get("server_url", ""))
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("The paired server_url must be an HTTPS origin.")
    for key in ("device_id", "token"):
        if not isinstance(config.get(key), str) or not config[key]:
            raise ValueError("Pairing file is missing " + key)
    pin = config.get("certificate_sha256", "")
    if pin and (len(pin) != 64 or any(c not in "0123456789abcdef" for c in pin)):
        raise ValueError("Invalid server certificate fingerprint.")
    return config


def send_batch(config, events):
    parsed = urlparse(config["server_url"])
    pin = config.get("certificate_sha256", "")
    context = ssl._create_unverified_context() if pin else ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, context=context, timeout=15)
    try:
        connection.connect()
        if pin:
            actual = hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest()
            if not hmac.compare_digest(pin, actual):
                raise ssl.SSLError("Server certificate changed. Re-pair this device before sending data.")
        body = json.dumps({"device_id": config["device_id"], "events": events})
        connection.request("POST", "/api/sync", body, {"Content-Type": "application/json", "Authorization": "Bearer " + config["token"]})
        response = connection.getresponse()
        data = json.loads(response.read())
        if response.status != 200:
            raise RuntimeError(data.get("error", "Device sync failed."))
        if data.get("accepted") != len(events):
            raise RuntimeError("Server did not acknowledge the complete batch.")
        return data
    finally:
        connection.close()


class Outbox:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS pending (event_id TEXT PRIMARY KEY, app TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, sealed INTEGER NOT NULL)")
            db.execute("UPDATE pending SET sealed=1")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def add(self, app, start, end):
        if not app or end <= start:
            return
        with self.connect() as db:
            previous = db.execute("SELECT * FROM pending WHERE sealed=0 LIMIT 1").fetchone()
            if previous and previous["app"] == app and previous["ended_at"] == start.isoformat() and (end - datetime.fromisoformat(previous["started_at"])).total_seconds() <= 60:
                db.execute("UPDATE pending SET ended_at=? WHERE event_id=?", (end.isoformat(), previous["event_id"]))
            else:
                db.execute("UPDATE pending SET sealed=1 WHERE sealed=0")
                db.execute("INSERT INTO pending VALUES(?,?,?,?,0)", (str(uuid4()), app, start.isoformat(), end.isoformat()))

    def seal(self):
        with self.connect() as db:
            db.execute("UPDATE pending SET sealed=1 WHERE sealed=0")

    def batch(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT event_id,app,started_at,ended_at FROM pending WHERE sealed=1 ORDER BY started_at LIMIT 200")]

    def acknowledge(self, events):
        with self.connect() as db:
            db.executemany("DELETE FROM pending WHERE event_id=? AND sealed=1", [(event["event_id"],) for event in events])

    def count(self):
        with self.connect() as db:
            return db.execute("SELECT COUNT(*) FROM pending").fetchone()[0]

    def flush(self, config, max_batches=10):
        for _ in range(max_batches):
            batch = self.batch()
            send_batch(config, batch)
            self.acknowledge(batch)
            if not batch:
                break
