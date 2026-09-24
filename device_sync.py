"""Paired, write-only device ingestion over certificate-pinned HTTPS."""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
from datetime import datetime, timedelta, timezone
from uuid import uuid4


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class DeviceStore:
    def __init__(self, connect, validate):
        self.connect, self.validate = connect, validate

    def initialize(self):
        with self.connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(entries)")}
            for column in ("device_id", "external_id"):
                if column not in columns:
                    db.execute(f"ALTER TABLE entries ADD COLUMN {column} TEXT")
            db.execute("""CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
                token_hash TEXT NOT NULL, created_at TEXT NOT NULL,
                last_seen TEXT, revoked INTEGER NOT NULL DEFAULT 0)""")
            db.execute("""CREATE TABLE IF NOT EXISTS sync_receipts (
                device_id TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
                PRIMARY KEY(device_id, event_id))""")
            db.execute("CREATE INDEX IF NOT EXISTS entries_device ON entries(device_id, started_at)")

    def register(self, data):
        name, platform = data.get("name"), data.get("platform")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            raise ValueError("Give the device a name of 1–80 characters.")
        if platform not in ("windows", "android", "chromeos"):
            raise ValueError("Choose Windows, Android, or ChromeOS.")
        device_id, token = str(uuid4()), secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute("INSERT INTO devices(id,name,platform,token_hash,created_at) VALUES(?,?,?,?,?)",
                       (device_id, name.strip(), platform, hashlib.sha256(token.encode()).hexdigest(), now_iso()))
        return {"device_id": device_id, "device_name": name.strip(), "platform": platform, "token": token}

    def devices(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT id,name,platform,created_at,last_seen,revoked FROM devices ORDER BY created_at")]

    def revoke(self, device_id):
        with self.connect() as db:
            return db.execute("UPDATE devices SET revoked=1 WHERE id=?", (device_id,)).rowcount > 0

    def authenticate(self, token):
        if not token or len(token) > 200:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.connect() as db:
            for row in db.execute("SELECT id,platform,token_hash FROM devices WHERE revoked=0"):
                if hmac.compare_digest(digest, row["token_hash"]):
                    return dict(row)
        return None

    def ingest(self, device, payload):
        if not isinstance(payload, dict) or payload.get("device_id") != device["id"]:
            raise ValueError("The device ID must match the paired device.")
        events = payload.get("events")
        if not isinstance(events, list) or len(events) > 200:
            raise ValueError("Send an events array with at most 200 sessions.")
        validated = []
        for event in events:
            if not isinstance(event, dict):
                raise ValueError("Each session must be an object.")
            event_id = event.get("event_id")
            if not isinstance(event_id, str) or not 1 <= len(event_id) <= 160:
                raise ValueError("Each session requires a stable event_id, up to 160 characters.")
            entry = self.validate({"kind": "screen", "label": event.get("app"),
                                   "started_at": event.get("started_at"), "ended_at": event.get("ended_at"),
                                   "source": device["platform"] + "-collector"})
            if datetime.fromisoformat(entry["ended_at"]) > datetime.now(timezone.utc) + timedelta(minutes=5):
                raise ValueError("Screen time cannot be in the future. Check the device clock.")
            entry.update(device_id=device["id"], external_id=event_id)
            canonical = [entry["label"], entry["started_at"], entry["ended_at"]]
            digest = hashlib.sha256(json.dumps(canonical).encode()).hexdigest()
            validated.append((entry, digest))
        inserted = 0
        with self.connect() as db:
            # Revocation can race with a request that was already authenticated.
            if not db.execute("SELECT id FROM devices WHERE id=? AND revoked=0", (device["id"],)).fetchone():
                raise ValueError("This device has been revoked.")
            for entry, digest in validated:
                receipt = db.execute("SELECT digest FROM sync_receipts WHERE device_id=? AND event_id=?",
                                     (device["id"], entry["external_id"])).fetchone()
                if receipt:
                    if not hmac.compare_digest(receipt["digest"], digest):
                        raise ValueError("An event_id was reused for a different session.")
                    continue
                db.execute("""INSERT INTO entries(id,kind,label,started_at,ended_at,value,unit,notes,source,created_at,device_id,external_id)
                    VALUES(:id,:kind,:label,:started_at,:ended_at,:value,:unit,:notes,:source,:created_at,:device_id,:external_id)""", entry)
                db.execute("INSERT INTO sync_receipts VALUES(?,?,?)", (device["id"], entry["external_id"], digest))
                inserted += 1
            db.execute("UPDATE devices SET last_seen=? WHERE id=?", (now_iso(), device["id"]))
        return {"accepted": len(events), "inserted": inserted, "server_time": now_iso()}


class SyncHandler(BaseHTTPRequestHandler):
    server_version = "SimonSealsAPISync/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_):
        pass

    def reply(self, status, data):
        if status >= 400 and self.command == "POST" and not getattr(self, "body_read", False):
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if 0 < size <= 262144:
                    self.connection.settimeout(1)
                    self.rfile.read(size)
            except (ValueError, OSError):
                pass
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(404, {"error": "This port only accepts paired device uploads."})

    def do_POST(self):
        if self.path != "/api/sync":
            return self.reply(404, {"error": "Not found."})
        authorization = self.headers.get("Authorization", "")
        device = self.server.store.authenticate(authorization[7:] if authorization.startswith("Bearer ") else "")
        if not device:
            return self.reply(401, {"error": "Device key invalid or revoked. Pair the device again."})
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.reply(415, {"error": "Send application/json."})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 262144:
                raise ValueError("The upload must be at most 256 KiB.")
            self.body_read = True
            result = self.server.store.ingest(device, json.loads(self.rfile.read(size)))
            self.reply(200, result)
        except (ValueError, OverflowError) as error:
            self.reply(400, {"error": str(error)})
        except Exception:
            self.reply(503, {"error": "Could not save this batch; retry with the same event IDs."})


def prepare_certificate(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    cert, key = directory / "sync-cert.pem", directory / "sync-key.pem"
    if not cert.exists() or not key.exists():
        executable = shutil.which("openssl")
        fallback = Path("C:/Program Files/Git/usr/bin/openssl.exe")
        if not executable and fallback.exists():
            executable = str(fallback)
        if not executable:
            raise RuntimeError("Install OpenSSL (included with Git for Windows) to enable HTTPS device sync.")
        config = directory / "openssl.cnf"
        config.write_text("[req]\ndistinguished_name = dn\n[dn]\n")
        subprocess.run([executable, "req", "-config", str(config), "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
                        "-keyout", str(key), "-out", str(cert), "-subj", "/CN=SimonSealsAPI Device Sync"],
                       check=True, capture_output=True)
    der = ssl.PEM_cert_to_DER_cert(cert.read_text())
    return cert, key, hashlib.sha256(der).hexdigest()


def union_minutes(intervals):
    """Elapsed time on any device, counting simultaneous use only once."""
    total, previous_start, previous_end = 0, None, None
    for start, end in sorted(intervals):
        if previous_end is None or start > previous_end:
            if previous_end is not None:
                total += (previous_end - previous_start).total_seconds()
            previous_start, previous_end = start, end
        else:
            previous_end = max(previous_end, end)
    if previous_end is not None:
        total += (previous_end - previous_start).total_seconds()
    return round(total / 60, 2)
