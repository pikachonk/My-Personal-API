"""SimonSealsAPI: a local personal activity API. Python 3.12+, no dependencies."""
import argparse
import hmac
import json
import math
import os
import sqlite3
import ssl
import threading
import secrets
import time as clock
from http.cookies import SimpleCookie
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import uuid4
from device_sync import DeviceStore, SyncHandler, prepare_certificate, union_minutes

ROOT = Path(__file__).resolve().parent
KINDS = {"water", "work", "gym", "sleep", "screen", "custom"}
DB_PATH = Path(os.environ.get("DAYBOOK_DB", ROOT / "data" / "daybook.db"))
SYNC_INFO = {"enabled": False}
PUBLIC_ORIGIN = ""
ADMIN_PASSWORD = ""
SESSIONS = {}
LOGIN_FAILURES = []


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def initialize():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""CREATE TABLE IF NOT EXISTS entries (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL,
            started_at TEXT NOT NULL, ended_at TEXT, value REAL, unit TEXT NOT NULL,
            notes TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL)""")
        conn.execute("CREATE INDEX IF NOT EXISTS entries_start ON entries(started_at)")
        conn.execute("""CREATE TABLE IF NOT EXISTS work_rules (
            type TEXT NOT NULL CHECK(type IN ('app', 'website')),
            label TEXT NOT NULL,
            classification TEXT NOT NULL CHECK(classification IN ('work', 'personal')),
            PRIMARY KEY(type, label))""")
    device_store().initialize()


def device_store():
    return DeviceStore(connect, validate_entry)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("A timestamp must be an ISO 8601 string with a timezone.")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Use an ISO 8601 timestamp with a timezone.") from None
    if result.utcoffset() is None:
        raise ValueError("Timestamps must include a timezone offset.")
    return result.astimezone(timezone.utc)


def short_text(data, key, default="", limit=200):
    value = data.get(key, default)
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{key} must be text, at most {limit} characters.")
    return value.strip()


def validate_entry(data):
    if not isinstance(data, dict):
        raise ValueError("Send a JSON object.")
    kind = data.get("kind")
    if not isinstance(kind, str) or kind not in KINDS:
        raise ValueError("kind must be water, work, gym, sleep, screen, or custom.")
    start = timestamp(data.get("started_at"))
    end = timestamp(data["ended_at"]) if data.get("ended_at") else None
    if end and end <= start:
        raise ValueError("The end must be after the start.")
    if end and (end - start).total_seconds() > 7 * 86400:
        raise ValueError("An activity may last at most seven days.")
    value = data.get("value")
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                              or not math.isfinite(value) or value <= 0 or value > 1000000):
        raise ValueError("value must be a positive number no greater than 1,000,000.")
    if kind == "water" and (value is None or value > 10000):
        raise ValueError("Water requires a value between 0 and 10,000 ml.")
    if kind == "water" and end:
        raise ValueError("Water entries use a single timestamp.")
    if kind in {"work", "gym", "sleep", "screen"} and not end:
        raise ValueError("This activity requires an end time.")
    label = short_text(data, "label") or kind.capitalize()
    unit = "ml" if kind == "water" else short_text(data, "unit", limit=30)
    return dict(id=str(uuid4()), kind=kind, label=label, started_at=start.isoformat(),
                ended_at=end.isoformat() if end else None, value=value, unit=unit,
                notes=short_text(data, "notes", limit=2000),
                source=short_text(data, "source", "manual", 80) or "manual",
                created_at=datetime.now(timezone.utc).isoformat())


def insert_entry(data):
    entry = validate_entry(data)
    with connect() as conn:
        conn.execute("INSERT INTO entries (id,kind,label,started_at,ended_at,value,unit,notes,source,created_at) VALUES (:id,:kind,:label,:started_at,:ended_at,"
                     ":value,:unit,:notes,:source,:created_at)", entry)
    return entry


def day_bounds(day, offset):
    # Browser supplies the UTC offset for the selected date, not the server's timezone.
    selected = date.fromisoformat(day)
    minutes = int(offset)
    if not -840 <= minutes <= 840:
        raise ValueError("offset must be between -840 and 840 minutes east of UTC.")
    zone = timezone(timedelta(minutes=minutes))
    start = datetime.combine(selected, time(), zone).astimezone(timezone.utc)
    return start, start + timedelta(days=1)


def entries_for_day(start, end):
    with connect() as conn:
        return [dict(row) for row in conn.execute(
            "SELECT entries.*, devices.name AS device_name FROM entries LEFT JOIN devices ON entries.device_id=devices.id WHERE started_at < ? AND "
            "((ended_at IS NULL AND started_at >= ?) OR ended_at > ?) "
            "ORDER BY started_at DESC", (end.isoformat(), start.isoformat(), start.isoformat()))]


BROWSER_APPS = {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe",
                "com.android.chrome", "com.microsoft.emmx", "org.mozilla.firefox"}


def validate_work_rule(data):
    if not isinstance(data, dict):
        raise ValueError("Send a JSON object.")
    rule_type = short_text(data, "type", limit=16)
    label = short_text(data, "label", limit=253 if rule_type == "website" else 200).lower()
    classification = short_text(data, "classification", limit=16)
    if rule_type not in {"app", "website"} or not label or classification not in {"work", "personal", "unclassified"}:
        raise ValueError("Choose an app or website and a classification.")
    if rule_type == "website":
        import re
        if not re.fullmatch(r"(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*", label):
            raise ValueError("Enter a valid website domain.")
    if rule_type == "app" and label in BROWSER_APPS:
        raise ValueError("Classify browser website domains instead of the entire browser.")
    return {"type": rule_type, "label": label, "classification": classification}


def summarize(entries, start, end, rules=()):
    totals = dict(water_ml=0, work_minutes=0, work_auto_minutes=0, work_manual_minutes=0,
                  gym_minutes=0, sleep_minutes=0, screen_minutes=0)
    manual_work, auto_work, screen_intervals, chrome, sites = [], [], [], {}, []
    by_rule = {(rule["type"], rule["label"]): rule["classification"] for rule in rules}
    for entry in entries:
        if entry["kind"] == "water":
            totals["water_ml"] += entry["value"]
        elif entry["kind"] in {"work", "gym", "sleep", "screen"}:
            interval = (max(timestamp(entry["started_at"]), start), min(timestamp(entry["ended_at"]), end))
            if interval[1] <= interval[0]:
                continue
            if entry["kind"] == "work":
                manual_work.append(interval)
            elif entry["kind"] != "screen" or entry["source"] != "windows-browser":
                totals[entry["kind"] + "_minutes"] += (interval[1] - interval[0]).total_seconds() / 60
            if entry["kind"] == "screen" and entry["source"] != "windows-browser":
                screen_intervals.append(interval)
                label = entry["label"].lower()
                if label in {"chrome.exe", "google chrome"}:
                    chrome.setdefault(entry.get("device_id"), []).append(interval)
                elif label not in BROWSER_APPS and by_rule.get(("app", label)) == "work":
                    auto_work.append(interval)
            elif entry["kind"] == "screen" and entry["source"] == "windows-browser" and by_rule.get(("website", entry["label"].lower())) == "work":
                sites.append((entry.get("device_id"), interval))
    for device_id, site in sites:
        for browser in chrome.get(device_id, []):
            overlap = (max(site[0], browser[0]), min(site[1], browser[1]))
            if overlap[1] > overlap[0]:
                auto_work.append(overlap)
    totals["screen_unique_minutes"] = union_minutes(screen_intervals)
    totals["work_auto_minutes"] = union_minutes(auto_work)
    totals["work_manual_minutes"] = union_minutes(manual_work)
    totals["work_minutes"] = union_minutes(auto_work + manual_work)
    return {key: round(value, 2) for key, value in totals.items()}


class Handler(BaseHTTPRequestHandler):
    server_version = "SimonSealsAPI/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_):
        pass  # Activity labels and API queries stay out of console logs.

    def reply(self, status, payload, content_type="application/json; charset=utf-8", headers=None):
        if status >= 400 and self.command == "POST" and not getattr(self, "body_read", False):
            # Drain a small rejected request so Windows does not reset before the error is delivered.
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if 0 < size <= 262144:
                    self.connection.settimeout(1)
                    self.rfile.read(size)
            except (ValueError, OSError):
                pass
        body = json.dumps(payload, allow_nan=False).encode() if content_type.startswith("application/json") else payload
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        # Reject cross-origin browser requests and DNS rebinding to the loopback service.
        hosts = {f"localhost:{self.server.server_port}", f"127.0.0.1:{self.server.server_port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        expected = PUBLIC_ORIGIN if PUBLIC_ORIGIN else f"http://{host}"
        if PUBLIC_ORIGIN:
            hosts = {urlparse(PUBLIC_ORIGIN).netloc}
        if host not in hosts or (origin and origin != expected):
            self.reply(403, {"error": "Use the dashboard's configured address."})
            return False
        if PUBLIC_ORIGIN and urlparse(self.path).path not in {"/login", "/login.js", "/style.css", "/magic.css", "/api/login"}:
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get("Cookie", ""))
                token = cookie["daybook_session"].value if "daybook_session" in cookie else ""
            except Exception:
                token = ""
            if SESSIONS.get(token, 0) < clock.monotonic():
                if self.path.startswith("/api/"):
                    self.reply(401, {"error": "Sign in to your dashboard."})
                else:
                    self.reply(302, {}, headers={"Location": "/login"})
                return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/health":
                return self.reply(200, {"status": "ok"})
            if parsed.path == "/api/devices":
                return self.reply(200, {"devices": device_store().devices(), "sync": SYNC_INFO})
            if parsed.path == "/api/work-rules":
                with connect() as conn:
                    rules = [dict(row) for row in conn.execute("SELECT type,label,classification FROM work_rules ORDER BY type,label")]
                return self.reply(200, {"rules": rules})
            if parsed.path == "/api/export":
                with connect() as conn:
                    entries = [dict(row) for row in conn.execute("SELECT * FROM entries ORDER BY started_at")]
                    rules = [dict(row) for row in conn.execute("SELECT type,label,classification FROM work_rules ORDER BY type,label")]
                return self.reply(200, {"version": 2, "exported_at": datetime.now(timezone.utc).isoformat(), "entries": entries, "devices": device_store().devices(), "work_rules": rules})
            if parsed.path in {"/api/day", "/api/entries"}:
                day = query.get("date", [date.today().isoformat()])[0]
                start, end = day_bounds(day, query.get("offset", ["0"])[0])
                # Explicit UTC bounds preserve 23/25-hour days across daylight saving changes.
                if "start" in query or "end" in query:
                    start = timestamp(query.get("start", [None])[0])
                    end = timestamp(query.get("end", [None])[0])
                    if not 0 < (end - start).total_seconds() <= 26 * 3600:
                        raise ValueError("The requested day must span at most 26 hours.")
                entries = entries_for_day(start, end)
                if parsed.path == "/api/entries":
                    return self.reply(200, {"entries": entries})
                with connect() as conn:
                    rules = [dict(row) for row in conn.execute("SELECT type,label,classification FROM work_rules")]
                return self.reply(200, {"date": day, "totals": summarize(entries, start, end, rules), "entries": entries})
            assets = {"/": ("index.html", "text/html; charset=utf-8"),
                      "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                      "/style.css": ("style.css", "text/css; charset=utf-8"),
                      "/magic.css": ("magic.css", "text/css; charset=utf-8"),
                      "/login": ("login.html", "text/html; charset=utf-8"),
                      "/login.js": ("login.js", "text/javascript; charset=utf-8"),
                      "/api/docs": ("api.html", "text/html; charset=utf-8")}
            if parsed.path in assets:
                name, mime = assets[parsed.path]
                return self.reply(200, (ROOT / "static" / name).read_bytes(), mime)
            self.reply(404, {"error": "Not found."})
        except (ValueError, OverflowError):
            self.reply(400, {"error": "Invalid date, offset, or day boundaries."})
        except sqlite3.Error:
            self.reply(503, {"error": "Could not read the database. Please try again."})

    def do_POST(self):
        if self.path == "/api/sync" and PUBLIC_ORIGIN:
            return SyncHandler.do_POST(self)
        if not self.allowed():
            return
        if self.path not in {"/api/entries", "/api/devices", "/api/login", "/api/logout"}:
            return self.reply(404, {"error": "Not found."})
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.reply(415, {"error": "Send Content-Type: application/json."})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 16384:
                raise ValueError("Request body must be between 1 and 16,384 bytes.")
            self.connection.settimeout(10)
            self.body_read = True
            data = json.loads(self.rfile.read(size))
            if self.path == "/api/login":
                if not PUBLIC_ORIGIN:
                    raise ValueError("Login is only used on the cloud server.")
                LOGIN_FAILURES[:] = [t for t in LOGIN_FAILURES if t > clock.monotonic() - 300]
                if len(LOGIN_FAILURES) >= 15:
                    return self.reply(429, {"error": "Too many attempts. Try again in five minutes."})
                supplied = data.get("password", "") if isinstance(data, dict) else ""
                if not isinstance(supplied, str) or not hmac.compare_digest(supplied.encode(), ADMIN_PASSWORD.encode()):
                    LOGIN_FAILURES.append(clock.monotonic())
                    return self.reply(401, {"error": "Incorrect password."})
                for key in list(SESSIONS):
                    if SESSIONS[key] < clock.monotonic():
                        SESSIONS.pop(key, None)
                token = secrets.token_urlsafe(32)
                SESSIONS[token] = clock.monotonic() + 43200
                return self.reply(200, {"signed_in": True}, headers={"Set-Cookie": f"daybook_session={token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200"})
            if self.path == "/api/logout":
                cookie = SimpleCookie(self.headers.get("Cookie", ""))
                if "daybook_session" in cookie:
                    SESSIONS.pop(cookie["daybook_session"].value, None)
                return self.reply(200, {"signed_out": True}, headers={"Set-Cookie": "daybook_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"})
            if self.path == "/api/devices":
                if not SYNC_INFO["enabled"]:
                    raise ValueError("Start the server with --sync-url https://YOUR-PC-IP:8443 to enable device pairing.")
                if not isinstance(data, dict):
                    raise ValueError("Send a JSON object.")
                config = device_store().register(data)
                config.update(server_url=SYNC_INFO["url"], certificate_sha256=SYNC_INFO["certificate_sha256"])
                return self.reply(201, config)
            entry = insert_entry(data)
            self.reply(201, entry)
        except (ValueError, UnicodeError, OverflowError) as error:
            self.reply(400, {"error": str(error)})
        except (sqlite3.Error, OSError):
            self.reply(503, {"error": "Could not save the entry. Please try again."})

    def do_PUT(self):
        if not self.allowed():
            return
        if urlparse(self.path).path != "/api/work-rules":
            return self.reply(404, {"error": "Not found."})
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.reply(415, {"error": "Send Content-Type: application/json."})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 16384:
                raise ValueError("Request body must be between 1 and 16,384 bytes.")
            self.connection.settimeout(10)
            data = json.loads(self.rfile.read(size))
            rule = validate_work_rule(data)
            with connect() as conn:
                if rule["classification"] == "unclassified":
                    conn.execute("DELETE FROM work_rules WHERE type=? AND label=?", (rule["type"], rule["label"]))
                else:
                    conn.execute("INSERT INTO work_rules(type,label,classification) VALUES(:type,:label,:classification) "
                                 "ON CONFLICT(type,label) DO UPDATE SET classification=excluded.classification", rule)
            return self.reply(200, rule)
        except (ValueError, UnicodeError, json.JSONDecodeError) as error:
            return self.reply(400, {"error": str(error)})
        except (sqlite3.Error, OSError):
            return self.reply(503, {"error": "Could not save the work rule. Please try again."})

    def do_DELETE(self):
        if not self.allowed():
            return
        path = urlparse(self.path).path
        if path.startswith("/api/devices/"):
            found = device_store().revoke(path.rsplit("/", 1)[-1])
            return self.reply(200 if found else 404, {"revoked": bool(found)})
        if not path.startswith("/api/entries/"):
            return self.reply(404, {"error": "Not found."})
        try:
            with connect() as conn:
                result = conn.execute("DELETE FROM entries WHERE id = ?", (path.rsplit("/", 1)[-1],))
            self.reply(200 if result.rowcount else 404,
                       {"deleted": True} if result.rowcount else {"error": "Entry not found."})
        except sqlite3.Error:
            self.reply(503, {"error": "Could not delete the entry. Please try again."})


def main():
    global PUBLIC_ORIGIN, ADMIN_PASSWORD
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--public-url", help="Public HTTPS origin behind a TLS reverse proxy; requires DAYBOOK_ADMIN_PASSWORD")
    parser.add_argument("--sync-url", help="HTTPS address devices can reach, e.g. https://192.168.2.154:8443")
    parser.add_argument("--sync-host", default="0.0.0.0", help="Bind address for the write-only HTTPS collector endpoint")
    parser.add_argument("--sync-port", type=int, default=8443)
    args = parser.parse_args()
    if args.public_url:
        parsed = urlparse(args.public_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/") or parsed.username or parsed.password or parsed.query or parsed.fragment:
            parser.error("--public-url must be an HTTPS origin.")
        PUBLIC_ORIGIN = args.public_url.rstrip("/")
        ADMIN_PASSWORD = os.environ.get("DAYBOOK_ADMIN_PASSWORD", "")
        if len(ADMIN_PASSWORD) < 16:
            parser.error("Set DAYBOOK_ADMIN_PASSWORD to at least 16 characters for cloud hosting.")
        SYNC_INFO.update(enabled=True, cloud=True, url=PUBLIC_ORIGIN, certificate_sha256="")
    elif args.host not in {"localhost", "127.0.0.1"}:
        parser.error("A network-accessible dashboard requires --public-url and DAYBOOK_ADMIN_PASSWORD.")
    initialize()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.store = device_store()
    sync_server = None
    if args.sync_url:
        parsed = urlparse(args.sync_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/") or parsed.username or parsed.password or parsed.query or parsed.fragment:
            parser.error("--sync-url must be an HTTPS origin without a path, query, or credentials.")
        cert, key, fingerprint = prepare_certificate(DB_PATH.parent)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert, key)
        sync_server = ThreadingHTTPServer((args.sync_host, args.sync_port), SyncHandler)
        sync_server.store = device_store()
        sync_server.socket = context.wrap_socket(sync_server.socket, server_side=True)
        SYNC_INFO.update(enabled=True, url=args.sync_url.rstrip("/"), certificate_sha256=fingerprint)
        threading.Thread(target=sync_server.serve_forever, daemon=True).start()
        print(f"Paired-device HTTPS sync: {args.sync_url}", flush=True)
    print(f"SimonSealsAPI is ready: http://localhost:{args.port}", flush=True)
    print("Your data stays in " + str(DB_PATH), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if sync_server:
            sync_server.shutdown()
            sync_server.server_close()


if __name__ == "__main__":
    main()
