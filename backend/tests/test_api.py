"""API regression suite (offline: OpenRouter is faked, nothing is spent).

Run from backend/:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import csv
import json
import unittest

from app import audit, core

from .helpers import API_KEY, ApiTestCase, FakeOpenRouter, tiny_png


class MetaTests(ApiTestCase, unittest.TestCase):
    def test_health_and_meta(self):
        self.assertEqual(self.client.get("/api/health").json(), {"ok": True})
        meta = self.client.get("/api/meta").json()
        self.assertEqual(meta["limits"]["max_files"], 5)
        self.assertEqual(meta["limits"]["max_file_bytes"], 5 * 1024 * 1024)
        self.assertIn("16:9", meta["aspect_ratios"])
        self.assertNotIn("providers", meta)

    def test_docs_and_removed_features_are_absent(self):
        for path in ("/docs", "/redoc", "/openapi.json", "/help", "/api/log", "/api/config",
                     "/api/keys", "/api/browse", "/api/analyse/rows"):
            self.assertEqual(self.client.get(path).status_code, 404, path)

    def test_security_headers(self):
        res = self.client.get("/api/meta")
        self.assertIn("frame-ancestors 'none'", res.headers["content-security-policy"])
        self.assertEqual(res.headers["x-content-type-options"], "nosniff")
        self.assertEqual(res.headers["referrer-policy"], "no-referrer")
        self.assertEqual(res.headers["cache-control"], "no-store")
        self.assertNotIn("server", res.headers)


class GenerateTests(ApiTestCase, unittest.TestCase):
    def test_generate_success_and_image(self):
        res = self.generate(seed="42")
        self.assertEqual(res.status_code, 200, res.text)
        snap = self.wait_job(res.json()["job_id"])
        self.assertEqual(snap["status"], "done", snap)
        self.assertEqual((snap["result"]["width"], snap["result"]["height"]), (4, 2))
        self.assertTrue(snap["result"]["filename"].endswith(".png"))
        img = self.client.get(f"/api/jobs/{res.json()['job_id']}/image")
        self.assertEqual(img.status_code, 200)
        self.assertEqual(img.headers["content-type"], "image/png")
        self.assertEqual(img.content[:8], b"\x89PNG\r\n\x1a\n")
        body = self.fake.bodies[0]
        self.assertEqual(body["model"], core.DEFAULT_MODEL)
        self.assertNotIn("n", body)  # single image per generation, always

    def test_storyboard_instruction_comes_first(self):
        job_id = self.generate(prompt="A cat finds a hat.", layout="2x3").json()["job_id"]
        self.wait_job(job_id)
        sent = self.fake.bodies[0]["prompt"]
        self.assertTrue(sent.startswith("You are a storyboard artist."))
        self.assertIn("exactly 2 rows and 3 columns (6 panels in total, 2 x 3)", sent)
        self.assertIn("Story:\nA cat finds a hat.", sent)
        self.assertIn("exactly 1 row and 6 columns", core.storyboard_instruction("1x6"))
        self.assertEqual(self.client.get("/api/meta").json()["layouts"], core.LAYOUTS)
        row = list(csv.DictReader((self.data_dir / audit.LOG_FILENAME).read_text().splitlines()))[-1]
        self.assertEqual(row["layout"], "2x3")

    def test_capability_lookup_keeps_model_slash(self):
        self.wait_job(self.generate(model="meta/muse-image").json()["job_id"])
        self.assertEqual(self.fake.get_urls[0],
                         "https://openrouter.ai/api/v1/images/models/meta/muse-image/endpoints")

    def test_events_stream_ends_with_result(self):
        job_id = self.generate().json()["job_id"]
        self.wait_job(job_id)
        with self.client.stream("GET", f"/api/jobs/{job_id}/events") as res:
            lines = [ln for ln in res.iter_lines() if ln.startswith("data: ")]
        last = json.loads(lines[-1][6:])
        self.assertEqual(last["status"], "done")
        self.assertIn("result", last)

    def test_uploads_become_context_and_references(self):
        self.fake.caps = {"aspect_ratio": {"type": "enum", "values": ["1:1"]},
                          "input_references": {"type": "range", "min": 0, "max": 4}}
        files = [("files", ("notes.md", b"# Hero\nRed scarf.", "text/markdown")),
                 ("files", ("ref.png", tiny_png(), "image/png"))]
        job_id = self.generate(files=files).json()["job_id"]
        self.assertEqual(self.wait_job(job_id)["status"], "done")
        body = self.fake.bodies[0]
        self.assertIn("=== notes.md ===", body["prompt"])
        self.assertIn("Red scarf.", body["prompt"])
        self.assertEqual(len(body["input_references"]), 1)
        self.assertTrue(body["input_references"][0]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_api_key_is_required_and_never_logged(self):
        res = self.generate(key=None)
        self.assertEqual(res.status_code, 400)
        self.assertIn("API key", res.json()["detail"])
        job_id = self.generate().json()["job_id"]
        self.wait_job(job_id)
        self.assertEqual(self.fake.headers[0]["Authorization"], f"Bearer {API_KEY}")
        log_text = (self.data_dir / audit.LOG_FILENAME).read_text()
        self.assertNotIn(API_KEY, log_text)
        rows = list(csv.DictReader(log_text.splitlines()))
        self.assertEqual(rows[-1]["status"], "done")
        self.assertEqual(len(rows[-1]["key_hash"]), 16)
        self.assertNotIn("testclient", log_text)  # client ip is hashed

    def test_validation_errors(self):
        cases = [
            (dict(prompt="  "), "prompt"),
            (dict(prompt="x" * (core.MAX_PROMPT_CHARS + 1)), "too long"),
            (dict(model="bad model!"), "model"),
            (dict(aspect_ratio="7:3"), "aspect ratio"),
            (dict(layout="4x4"), "layout"),
            (dict(layout=""), "layout"),
            (dict(resolution="8K"), "resolution"),
            (dict(seed="-1"), "seed"),
            (dict(key="short"), "API key"),
        ]
        for fields, needle in cases:
            res = self.generate(**fields)
            self.assertEqual(res.status_code, 400, fields)
            self.assertIn(needle, res.json()["detail"], fields)
        self.assertEqual(self.fake.bodies, [])

    def test_upload_limits(self):
        six = [("files", (f"f{i}.txt", b"hello", "text/plain")) for i in range(6)]
        self.assertEqual(self.generate(files=six).status_code, 400)
        big = [("files", ("big.txt", b"a" * (core.MAX_UPLOAD_BYTES + 1), "text/plain"))]
        res = self.generate(files=big)
        self.assertEqual(res.status_code, 400)
        self.assertIn("5 MB", res.json()["detail"])
        exe = [("files", ("run.sh", b"#!/bin/sh\necho hi", "text/x-sh"))]
        self.assertIn("only PNG", self.generate(files=exe).json()["detail"])
        fake_png = [("files", ("x.png", b"not really a png", "image/png"))]
        self.assertEqual(self.generate(files=fake_png).status_code, 400)
        self.assertEqual(self.fake.bodies, [])

    def test_body_size_cap(self):
        app_settings = self.app.state.settings
        res = self.client.post("/api/generate", content=b"x" * (app_settings.max_body_bytes + 1),
                               headers={"Content-Type": "multipart/form-data; boundary=x",
                                        "X-Api-Key": API_KEY})
        self.assertEqual(res.status_code, 413)

    def test_cross_origin_post_rejected(self):
        res = self.client.post("/api/generate", headers={"Origin": "https://evil.example"})
        self.assertEqual(res.status_code, 403)

    def test_provider_errors_are_friendly_and_redacted(self):
        self.fake = FakeOpenRouter(status=500, raw=json.dumps({"error": {"message": f"boom {API_KEY}"}}))
        snap = self.wait_job(self.generate().json()["job_id"])
        self.assertEqual(snap["status"], "error")
        self.assertIn("HTTP 500", snap["error"])
        self.assertNotIn(API_KEY, snap["error"])
        self.assertIn("[redacted]", snap["error"])

    def test_content_policy(self):
        self.fake = FakeOpenRouter(status=400, raw='{"error": {"message": "content policy violation"}}')
        snap = self.wait_job(self.generate().json()["job_id"])
        self.assertIn("content filter", snap["error"])

    def test_cancel_only_affects_own_job(self):
        self.rebuild(max_jobs_per_client=2)
        self.fake = FakeOpenRouter(delay_s=1.0)
        first = self.generate().json()["job_id"]
        second = self.generate().json()["job_id"]
        self.assertTrue(self.client.post(f"/api/jobs/{first}/cancel").json()["cancelled"])
        self.assertEqual(self.wait_job(first)["status"], "cancelled")
        self.assertEqual(self.wait_job(second)["status"], "done")
        self.assertEqual(self.client.get(f"/api/jobs/{first}/image").status_code, 404)

    def test_unknown_job(self):
        self.assertEqual(self.client.get("/api/jobs/" + "0" * 32 + "/events").status_code, 404)
        self.assertEqual(self.client.get("/api/jobs/../../etc/passwd/image").status_code, 404)

    def test_outdated_log_is_rotated(self):
        (self.data_dir / audit.LOG_FILENAME).write_text("date,prompt\n2026-01-01,old\n")
        self.wait_job(self.generate().json()["job_id"])
        rows = list(csv.DictReader((self.data_dir / audit.LOG_FILENAME).read_text().splitlines()))
        self.assertEqual(list(rows[0]), audit.LOG_FIELDS)
        self.assertEqual(len(list(self.data_dir.glob("generation_log.*.csv"))), 1)

    def test_csv_formula_injection_is_neutralised(self):
        self.wait_job(self.generate(prompt="=HYPERLINK(\"http://x\")").json()["job_id"])
        rows = list(csv.DictReader((self.data_dir / audit.LOG_FILENAME).read_text().splitlines()))
        self.assertTrue(rows[-1]["prompt"].startswith("'="))


class AbuseProtectionTests(ApiTestCase, unittest.TestCase):
    settings_overrides = dict(generate_per_minute=2, auth_failures_before_lock=3)

    def test_generate_rate_limit(self):
        for _ in range(2):
            self.wait_job(self.generate().json()["job_id"])
        res = self.generate()
        self.assertEqual(res.status_code, 429)
        self.assertIn("Retry-After", res.headers)

    def test_one_running_job_per_client(self):
        self.fake = FakeOpenRouter(delay_s=0.5)
        first = self.generate()
        self.assertEqual(first.status_code, 200)
        busy = self.generate()
        self.assertEqual(busy.status_code, 429)
        self.assertIn("already have a generation running", busy.json()["detail"])
        self.wait_job(first.json()["job_id"])

    def test_rejected_keys_lock_the_client(self):
        self.rebuild(generate_per_minute=0)  # 0 = unlimited: only the lock may refuse
        self.fake = FakeOpenRouter(status=401, raw='{"error": {"message": "No auth credentials"}}')
        for _ in range(3):
            snap = self.wait_job(self.generate().json()["job_id"])
            self.assertIn("rejected the API key", snap["error"])
        res = self.generate()
        self.assertEqual(res.status_code, 429)
        self.assertIn("rejected API keys", res.json()["detail"])

    def test_api_rate_limit(self):
        self.rebuild(api_per_minute=3)
        codes = [self.client.get("/api/meta").status_code for _ in range(4)]
        self.assertEqual(codes, [200, 200, 200, 429])
        self.assertEqual(self.client.get("/api/health").status_code, 200)


if __name__ == "__main__":
    unittest.main()
