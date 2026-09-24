from datetime import datetime, timedelta, timezone
import hashlib
import http.client
import json
from pathlib import Path
import ssl
import tempfile
import threading
import unittest
from unittest.mock import patch

import server
from device_sync import SyncHandler, prepare_certificate
from collectors.sync_client import Outbox, send_batch


class DeviceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_db = server.DB_PATH
        server.DB_PATH = Path(self.temp.name) / "daybook.db"
        server.initialize()
        self.store = server.device_store()
        self.config = self.store.register({"name":"Work PC", "platform":"windows"})
        self.device = self.store.authenticate(self.config["token"])
        self.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.http.store = self.store
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.old_public, self.old_password, self.old_sync = server.PUBLIC_ORIGIN, server.ADMIN_PASSWORD, server.SYNC_INFO.copy()

    def tearDown(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        server.PUBLIC_ORIGIN, server.ADMIN_PASSWORD = self.old_public, self.old_password
        server.SYNC_INFO.clear(); server.SYNC_INFO.update(self.old_sync)
        server.SESSIONS.clear(); server.LOGIN_FAILURES.clear()
        server.DB_PATH = self.previous_db
        self.temp.cleanup()

    def request(self, method, path, data=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=5)
        connection.request(method, path, json.dumps(data) if data is not None else None,
                           {"Content-Type":"application/json", **(headers or {})})
        response = connection.getresponse(); body = response.read()
        result = response.status, dict(response.getheaders()), json.loads(body) if "application/json" in response.getheader("Content-Type", "") else body
        connection.close(); return result

    def event(self, event_id="one", **changes):
        return {"event_id":event_id, "app":"chrome.exe", "started_at":"2026-09-22T10:00:00Z", "ended_at":"2026-09-22T11:00:00Z", **changes}

    def upload(self, events, device=None):
        device = device or self.device
        return self.store.ingest(device, {"device_id":device["id"], "events":events})

    def test_retries_and_deleted_records_do_not_reappear(self):
        self.assertEqual(self.upload([self.event()])["inserted"], 1)
        self.assertEqual(self.upload([self.event()])["inserted"], 0)
        with server.connect() as db: db.execute("DELETE FROM entries")
        self.assertEqual(self.upload([self.event()])["inserted"], 0)

    def test_per_device_ids_and_overlapping_time(self):
        other = self.store.register({"name":"Pixel", "platform":"android"})
        device = self.store.authenticate(other["token"])
        self.upload([self.event()])
        self.upload([self.event(started_at="2026-09-22T10:30:00Z", ended_at="2026-09-22T11:30:00Z")], device)
        result = self.request("GET", "/api/day?date=2026-09-22")[2]
        self.assertEqual(result["totals"]["screen_minutes"], 120)
        self.assertEqual(result["totals"]["screen_unique_minutes"], 90)
        self.assertEqual({e["device_name"] for e in result["entries"]}, {"Work PC", "Pixel"})

    def test_failed_batch_is_atomic(self):
        with self.assertRaises(ValueError): self.upload([self.event(), self.event("bad", ended_at="bad")])
        self.assertEqual(self.request("GET", "/api/export")[2]["entries"], [])
        self.upload([self.event()])
        with self.assertRaises(ValueError): self.upload([self.event("two"), self.event(app="other.exe")])
        self.assertEqual(len(self.request("GET", "/api/export")[2]["entries"]), 1)

    def test_wrong_device_rejected_and_key_revocable(self):
        with self.assertRaises(ValueError): self.store.ingest(self.device, {"device_id":"different", "events":[]})
        self.store.revoke(self.device["id"])
        self.assertIsNone(self.store.authenticate(self.config["token"]))
        with self.assertRaises(ValueError): self.upload([])

    def test_heartbeat_and_no_secrets_in_export(self):
        self.upload([])
        result = self.request("GET", "/api/export")[2]
        self.assertIsNotNone(result["devices"][0]["last_seen"])
        self.assertNotIn(self.config["token"], json.dumps(result))
        self.assertNotIn(hashlib.sha256(self.config["token"].encode()).hexdigest(), json.dumps(result))

    def test_cloud_login_pairing_scope_and_logout(self):
        server.PUBLIC_ORIGIN = "https://daybook.example.test"
        server.ADMIN_PASSWORD = "a-test-password-very-long"
        server.SYNC_INFO.update(enabled=True, url=server.PUBLIC_ORIGIN, certificate_sha256="")
        host = {"Host":"daybook.example.test"}
        self.assertEqual(self.request("GET", "/api/export", headers=host)[0], 401)
        self.assertEqual(self.request("GET", "/", headers=host)[0], 302)
        self.assertEqual(self.request("POST", "/api/login", {"password":"wrong"}, host)[0], 401)
        code, headers, _ = self.request("POST", "/api/login", {"password":server.ADMIN_PASSWORD}, host)
        self.assertEqual(code, 200)
        self.assertIn("Secure", headers["Set-Cookie"])
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        signed_in = {**host, "Cookie":headers["Set-Cookie"].split(";")[0]}
        self.assertEqual(self.request("GET", "/api/export", headers=signed_in)[0], 200)
        result = self.request("POST", "/api/devices", {"name":"Pixel 2", "platform":"android"}, signed_in)
        self.assertEqual(result[0], 201)
        self.assertEqual(result[2]["server_url"], server.PUBLIC_ORIGIN)
        device_headers = {**host, "Authorization":"Bearer " + self.config["token"]}
        self.assertEqual(self.request("GET", "/api/export", headers=device_headers)[0], 401)
        self.assertEqual(self.request("POST", "/api/sync", {"device_id":self.device["id"], "events":[self.event()]}, device_headers)[0], 200)
        self.assertEqual(self.request("POST", "/api/logout", {}, signed_in)[0], 200)
        self.assertEqual(self.request("GET", "/api/export", headers=signed_in)[0], 401)

    def test_tls_transport_and_certificate_pinning(self):
        cert, key, fingerprint = prepare_certificate(Path(self.temp.name) / "tls")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert, key)
        listener = server.ThreadingHTTPServer(("127.0.0.1", 0), SyncHandler)
        listener.store = self.store
        listener.socket = context.wrap_socket(listener.socket, server_side=True)
        worker = threading.Thread(target=listener.serve_forever, daemon=True); worker.start()
        try:
            config = {**self.config, "server_url":f"https://127.0.0.1:{listener.server_port}", "certificate_sha256":fingerprint}
            self.assertEqual(send_batch(config, [self.event()])["inserted"], 1)
            self.assertEqual(send_batch(config, [self.event()])["inserted"], 0)
            with self.assertRaises(ssl.SSLError): send_batch({**config, "certificate_sha256":"0"*64}, [self.event("never")])
            self.store.revoke(self.device["id"])
            with self.assertRaises(RuntimeError): send_batch(config, [])
        finally:
            listener.shutdown(); listener.server_close(); worker.join()


class OutboxTests(unittest.TestCase):
    def test_crash_recovery_and_failed_send_keeps_sessions(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "outbox.db"
            start = datetime(2026,9,22,10,tzinfo=timezone.utc)
            queue = Outbox(path)
            queue.add("chrome.exe", start, start + timedelta(seconds=5))
            queue.add("chrome.exe", start + timedelta(seconds=5), start + timedelta(seconds=10))
            self.assertEqual(queue.count(), 1)
            self.assertEqual(queue.batch(), [])
            recovered = Outbox(path)
            batch = recovered.batch()
            self.assertEqual(len(batch), 1)
            with patch("collectors.sync_client.send_batch", side_effect=OSError("offline")):
                with self.assertRaises(OSError): recovered.flush({})
            self.assertEqual(recovered.batch(), batch)
            with patch("collectors.sync_client.send_batch", return_value={"accepted":1}): recovered.flush({})
            self.assertEqual(recovered.count(), 0)

    def test_sealed_sessions_are_immutable_during_upload(self):
        with tempfile.TemporaryDirectory() as temp:
            queue = Outbox(Path(temp) / "outbox.db")
            start = datetime(2026,9,22,10,tzinfo=timezone.utc)
            queue.add("chrome", start, start + timedelta(seconds=5)); queue.seal()
            uploaded = queue.batch()
            queue.add("chrome", start + timedelta(seconds=5), start + timedelta(seconds=10))
            queue.acknowledge(uploaded)
            self.assertEqual(queue.count(), 1)
