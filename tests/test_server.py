import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import urlencode

import server


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.old_db = server.DB_PATH
        server.DB_PATH = Path(cls.temp.name) / "test.db"
        server.initialize()
        cls.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        server.DB_PATH = cls.old_db
        cls.temp.cleanup()

    def setUp(self):
        with server.connect() as conn:
            conn.execute("DELETE FROM entries")
            conn.execute("DELETE FROM work_rules")

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=5)
        request_headers = {"Content-Type": "application/json"}
        request_headers.update(headers or {})
        connection.request(method, path, json.dumps(body) if body is not None else None, request_headers)
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, json.loads(payload) if "application/json" in response.getheader("Content-Type", "") else payload)
        connection.close()
        return result

    def water(self, **changes):
        return {"kind": "water", "value": 250, "started_at": "2026-09-22T09:00:00-04:00", **changes}

    def test_create_read_export_delete(self):
        status, entry = self.request("POST", "/api/entries", self.water(notes="After breakfast"))
        self.assertEqual(status, 201)
        self.assertEqual(entry["started_at"], "2026-09-22T13:00:00+00:00")
        status, day = self.request("GET", "/api/day?date=2026-09-22&offset=-240")
        self.assertEqual(status, 200)
        self.assertEqual(day["totals"]["water_ml"], 250)
        self.assertEqual(day["entries"][0]["notes"], "After breakfast")
        self.assertEqual(self.request("GET", "/api/export")[1]["entries"][0]["id"], entry["id"])
        self.assertEqual(self.request("DELETE", "/api/entries/" + entry["id"])[0], 200)
        self.assertEqual(self.request("DELETE", "/api/entries/" + entry["id"])[0], 404)
        self.assertEqual(self.request("GET", "/api/export")[1]["entries"], [])

    def test_overnight_sleep_split(self):
        self.request("POST", "/api/entries", {"kind": "sleep", "started_at": "2026-09-21T23:00:00-04:00", "ended_at": "2026-09-22T07:00:00-04:00"})
        for day, minutes in [("21",60),("22",420),("23",0)]:
            with self.subTest(day=day):
                result = self.request("GET", f"/api/day?date=2026-09-{day}&offset=-240")[1]
                self.assertEqual(result["totals"]["sleep_minutes"], minutes)

    def test_daylight_saving_explicit_bounds(self):
        self.request("POST", "/api/entries", {"kind":"sleep", "started_at":"2026-11-01T00:00:00-04:00", "ended_at":"2026-11-01T08:00:00-05:00"})
        query = urlencode({"date":"2026-11-01", "start":"2026-11-01T00:00:00-04:00", "end":"2026-11-02T00:00:00-05:00"})
        self.assertEqual(self.request("GET", "/api/day?" + query)[1]["totals"]["sleep_minutes"], 540)

    def test_midnight_end_is_exclusive(self):
        self.request("POST", "/api/entries", {"kind":"work", "started_at":"2026-09-21T23:00:00Z", "ended_at":"2026-09-22T00:00:00Z"})
        self.assertEqual(self.request("GET", "/api/entries?date=2026-09-22")[1]["entries"], [])

    def test_invalid_entries(self):
        invalid = [self.water(value=-1), self.water(value=0), self.water(value=True), self.water(value=float("nan")),
                   self.water(value=float("inf")), self.water(value=10001), self.water(kind=[]),
                   self.water(started_at="2026-09-22T09:00:00"), self.water(kind="unknown"),
                   self.water(label="a"*201), self.water(notes=17), self.water(kind="work"), [],
                   self.water(ended_at="2026-09-22T10:00:00-04:00"),
                   {"kind":"work", "started_at":"2026-09-22T10:00:00Z", "ended_at":"2026-09-22T09:00:00Z"}]
        for entry in invalid:
            with self.subTest(entry=entry):
                self.assertEqual(self.request("POST", "/api/entries", entry)[0], 400)

    def test_custom_activity(self):
        status, entry = self.request("POST", "/api/entries", {"kind":"custom", "label":"Reading", "value":20, "unit":"pages", "started_at":"2026-09-22T12:00:00Z"})
        self.assertEqual(status, 201)
        self.assertEqual(entry["unit"], "pages")

    def test_all_timed_categories(self):
        for kind in ["work", "gym", "screen", "sleep"]:
            self.assertEqual(self.request("POST", "/api/entries", {"kind":kind, "started_at":"2026-09-22T10:00:00Z", "ended_at":"2026-09-22T11:30:00Z"})[0], 201)
        totals = self.request("GET", "/api/day?date=2026-09-22")[1]["totals"]
        for kind in ["work", "gym", "screen", "sleep"]:
            self.assertEqual(totals[kind + "_minutes"], 90)

    def test_work_rules_count_selected_screen_time_and_overlap_once(self):
        for label, source, start, end in [
            ("code.exe", "windows-collector", "10:00", "11:00"),
            ("chrome.exe", "windows-collector", "11:00", "12:00"),
            ("example.com", "windows-browser", "11:15", "11:45"),
        ]:
            self.assertEqual(self.request("POST", "/api/entries", {
                "kind": "screen", "label": label, "source": source,
                "started_at": f"2026-09-22T{start}:00Z", "ended_at": f"2026-09-22T{end}:00Z"})[0], 201)
        path = "/api/day?date=2026-09-22"
        self.assertEqual(self.request("GET", path)[1]["totals"]["work_minutes"], 0)
        self.assertEqual(self.request("PUT", "/api/work-rules", {"type":"app", "label":"chrome.exe", "classification":"work"})[0], 400)
        for rule in [{"type":"app", "label":"CODE.EXE", "classification":"work"},
                     {"type":"website", "label":"example.com", "classification":"work"}]:
            self.assertEqual(self.request("PUT", "/api/work-rules", rule)[0], 200)
        self.assertEqual(len(self.request("GET", "/api/work-rules")[1]["rules"]), 2)
        self.assertEqual(self.request("GET", path)[1]["totals"]["work_auto_minutes"], 90)
        self.request("POST", "/api/entries", {"kind":"work", "started_at":"2026-09-22T11:30:00Z", "ended_at":"2026-09-22T12:00:00Z"})
        self.assertEqual(self.request("GET", path)[1]["totals"]["work_minutes"], 105)

    def test_persistence_after_initialize(self):
        self.request("POST", "/api/entries", self.water())
        server.initialize()
        self.assertEqual(len(self.request("GET", "/api/export")[1]["entries"]), 1)

    def test_browser_origin_and_host_protection(self):
        self.assertEqual(self.request("POST", "/api/entries", self.water(), {"Origin":"https://evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/export", headers={"Host":"evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/entries", self.water(), {"Content-Type":"text/plain"})[0], 415)

    def test_invalid_queries(self):
        for query in ["date=bad", "date=2026-09-22&offset=9999", "start=bad", "start=2026-09-22T00:00:00Z&end=2026-09-24T00:00:00Z"]:
            self.assertEqual(self.request("GET", "/api/day?"+query)[0], 400)

    def test_assets_and_no_path_traversal(self):
        for path in ["/", "/style.css", "/app.js", "/api/docs", "/api/health", "/api/work-ai"]:
            self.assertEqual(self.request("GET", path)[0], 200)
        for path in ["/../server.py", "/data/daybook.db", "/does-not-exist"]:
            self.assertEqual(self.request("GET", path)[0], 404)


if __name__ == "__main__":
    unittest.main()
