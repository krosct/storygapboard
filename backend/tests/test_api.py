"""API regression suite (offline: OpenRouter is faked, nothing is spent).

Run from backend/:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import base64
import csv
import json
import unittest

from fastapi.testclient import TestClient

from app import audit, core

from .helpers import API_KEY, ApiTestCase, FakeOpenRouter, tiny_png


class MetaTests(ApiTestCase, unittest.TestCase):
    def test_health_and_meta(self):
        self.assertEqual(self.client.get("/api/health").json(), {"ok": True})
        meta = self.client.get("/api/meta").json()
        self.assertEqual(meta["limits"]["max_files"], 5)
        self.assertEqual(meta["limits"]["max_file_bytes"], 5 * 1024 * 1024)
        self.assertIn("16:9", meta["aspect_ratios"])
        # the visitor picks among well-known panel shapes; the model may still be asked any board ratio
        self.assertEqual(meta["aspect_ratios"], core.PANEL_RATIOS)
        self.assertEqual(len(core.PANEL_RATIOS), 10)
        self.assertIn("5:4", meta["board_ratios"])
        self.assertNotIn("1:8", meta["aspect_ratios"])
        self.assertEqual([p["id"] for p in meta["providers"]], ["openrouter", "openai"])
        self.assertEqual(meta["default_provider"], "openrouter")

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
        self.assertNotIn("strict-transport-security", res.headers)  # plain HTTP (local runs)

    def test_hsts_over_https(self):
        res = TestClient(self.app, base_url="https://testserver").get("/api/health")
        self.assertEqual(res.headers["strict-transport-security"], "max-age=31536000")

    def test_hashed_assets_are_cached_for_good(self):
        dist = self.data_dir / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<title>StoryGapBoard</title>")
        (dist / "assets" / "index-abc123.js").write_text("console.log(1)")
        self.rebuild(frontend_dist=dist)
        asset = self.client.get("/assets/index-abc123.js")
        self.assertEqual(asset.headers["cache-control"], "public, max-age=31536000, immutable")
        self.assertNotIn("cache-control", self.client.get("/").headers)
        self.assertNotIn("cache-control", self.client.get("/assets/missing.js").headers)


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

    def test_model_is_always_asked_for_png(self):
        # the visitor's format is for the download (made in the browser); the model always gets png
        self.fake.caps = {"output_format": {"type": "enum", "values": ["png", "jpeg", "webp"]}}
        self.wait_job(self.generate(output_format="jpeg").json()["job_id"])
        self.assertEqual(self.fake.bodies[0]["output_format"], "png")
        # a model without png: no format sent, it uses its own default
        core._CAPS_CACHE.clear()
        self.fake.caps = {"output_format": {"type": "enum", "values": ["jpeg"]}}
        self.wait_job(self.generate(output_format="webp").json()["job_id"])
        self.assertNotIn("output_format", self.fake.bodies[1])
        row = list(csv.DictReader((self.data_dir / audit.LOG_FILENAME).read_text().splitlines()))[-1]
        self.assertEqual(row["output_format_req"], "webp")  # the log keeps what the visitor chose

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

    def test_fixed_panels_send_the_layout_guide_first(self):
        self.fake.caps = {"input_references": {"type": "range", "min": 0, "max": 2}}
        files = [("files", ("ref.jpg", tiny_png(), "image/png")),
                 ("files", ("ref2.png", tiny_png(), "image/png")),
                 ("guide", ("guide.png", tiny_png(6, 4), "image/png"))]
        job_id = self.generate(files=files, fixed_panels="4,1").json()["job_id"]
        self.assertEqual(self.wait_job(job_id)["status"], "done")
        body = self.fake.bodies[0]
        self.assertIn("Panels 1 and 4 are already finished", body["prompt"])
        self.assertIn("Panels 2, 3, 5 and 6 are gray numbered placeholders", body["prompt"])
        self.assertLess(body["prompt"].index("layout guide"), body["prompt"].index("Story:"))
        # capped at 2 references: the guide (first) is kept
        guide_b64 = base64.b64encode(tiny_png(6, 4)).decode()
        self.assertEqual(len(body["input_references"]), 2)
        self.assertTrue(body["input_references"][0]["image_url"]["url"].endswith(guide_b64))
        row = list(csv.DictReader((self.data_dir / audit.LOG_FILENAME).read_text().splitlines()))[-1]
        self.assertEqual((row["mode"], row["fixed_panels"]), ("storyboard", "1 4"))

    def test_fixed_panels_validation(self):
        guide = [("guide", ("guide.png", tiny_png(), "image/png"))]
        cases = [
            (dict(fixed_panels="7"), guide, "fixed panels"),
            (dict(fixed_panels="0"), guide, "fixed panels"),
            (dict(fixed_panels="1,x"), guide, "fixed panels"),
            (dict(fixed_panels="1,2,3,4,5,6"), guide, "at least one panel empty"),
            (dict(fixed_panels="1"), [], "layout guide"),
            (dict(fixed_panels="1"), [("guide", ("g.txt", b"hi", "text/plain"))], "layout guide"),
            (dict(), guide, "layout guide"),
        ]
        for fields, files, needle in cases:
            res = self.generate(files=files, **fields)
            self.assertEqual(res.status_code, 400, fields)
            self.assertIn(needle, res.json()["detail"], fields)
        self.assertEqual(self.fake.bodies, [])

    def test_edit_sends_panel_and_marks(self):
        self.fake.caps = {"aspect_ratio": {"type": "enum", "values": ["1:1", "16:9"]},
                          "input_references": {"type": "range", "min": 0, "max": 4}}
        res = self.edit(prompt="Make the hat red.", area="60,5,95,40", mark_color="green")
        self.assertEqual(res.status_code, 200, res.text)
        snap = self.wait_job(res.json()["job_id"])
        self.assertEqual(snap["status"], "done", snap)
        self.assertTrue(snap["result"]["filename"].startswith("panel_"))
        body = self.fake.bodies[0]
        self.assertTrue(body["prompt"].startswith("You are editing ONE panel of a storyboard."))
        self.assertIn("with green marks", body["prompt"])
        self.assertIn("the green is only a pointer", body["prompt"])
        self.assertNotIn("red marks", body["prompt"])
        self.assertIn("Change:\nMake the hat red.", body["prompt"])
        self.assertIn("The marked area is in the top right of the panel, spanning about 60-95%", body["prompt"])
        self.assertNotIn("storyboard grid", body["prompt"])
        self.assertEqual(body["aspect_ratio"], "16:9")
        self.assertEqual(len(body["input_references"]), 2)
        row = list(csv.DictReader((self.data_dir / audit.LOG_FILENAME).read_text().splitlines()))[-1]
        self.assertEqual(row["mode"], "edit")

    def test_edit_validation(self):
        res = self.edit(marked=tiny_png(8, 8))
        self.assertEqual(res.status_code, 400)
        self.assertIn("same size", res.json()["detail"])
        res = self.client.post("/api/edit", headers={"X-Api-Key": API_KEY},
                               files=[("prompt", (None, "x")), ("model", (None, "")),
                                      ("resolution", (None, "1K")), ("output_format", (None, "png")),
                                      ("panel", ("p.png", tiny_png(), "image/png"))])
        self.assertEqual(res.status_code, 400)
        self.assertIn("marked panel", res.json()["detail"])
        self.assertEqual(self.edit(prompt=" ").status_code, 400)
        res = self.edit(mark_color="purple")
        self.assertEqual(res.status_code, 400)
        self.assertIn("mark color", res.json()["detail"])
        for area in ("1,2,3", "50,10,40,90", "0,0,101,50", "a,b,c,d"):
            res = self.edit(area=area)
            self.assertEqual(res.status_code, 400, area)
            self.assertIn("marked area", res.json()["detail"])
        self.assertEqual(self.fake.bodies, [])

    def test_edit_needs_a_model_with_image_input(self):
        self.fake.caps = {"aspect_ratio": {"type": "enum", "values": ["1:1"]}}
        snap = self.wait_job(self.edit().json()["job_id"])
        self.assertEqual(snap["status"], "error")
        self.assertIn("cannot edit a panel", snap["error"])
        self.assertEqual(self.fake.bodies, [])

    def test_prompt_is_optional(self):
        job_id = self.generate(prompt="  ").json()["job_id"]
        self.assertEqual(self.wait_job(job_id)["status"], "done")
        sent = self.fake.bodies[0]["prompt"]
        self.assertIn("Story: none given. Make up a simple, coherent story", sent)
        guide = [("guide", ("guide.png", tiny_png(), "image/png"))]
        self.wait_job(self.generate(prompt="", files=guide, fixed_panels="2").json()["job_id"])
        sent = self.fake.bodies[1]["prompt"]
        self.assertIn("Infer the story from the finished panels", sent)
        self.assertIn("Panels 1, 3, 4, 5 and 6 are gray numbered placeholders: draw them", sent)
        one = core.fixed_panels_instruction("1x3", [1, 3])
        self.assertIn("Panel 2 is a gray numbered placeholder: draw it so", one)

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


class OpenAITests(ApiTestCase, unittest.TestCase):
    """OpenAI Image API: generations (JSON) without input images, edits (multipart) with them."""

    def parts(self, body: bytes) -> list[tuple[str, bytes]]:
        boundary = body.split(b"\r\n", 1)[0]
        out = []
        for chunk in body.split(boundary)[1:-1]:
            head, _, value = chunk.strip(b"\r\n").partition(b"\r\n\r\n")
            name = head.split(b'name="', 1)[1].split(b'"', 1)[0].decode()
            out.append((name, value))
        return out

    def test_generate_without_images_uses_generations(self):
        snap = self.wait_job(self.generate(provider="openai", aspect_ratio="16:9", seed="7",
                                           output_format="jpeg").json()["job_id"])
        self.assertEqual(snap["status"], "done", snap)
        self.assertEqual(self.fake.urls[0], core.OPENAI_GENERATIONS_URL)
        self.assertEqual(self.fake.get_urls, [])  # no OpenRouter capability lookup
        body = self.fake.bodies[0]
        self.assertEqual(body["model"], "gpt-image-2.5-flare")
        self.assertEqual(body["size"], "1360x768")
        self.assertEqual(body["output_format"], "png")  # explicit, whatever the visitor's download format
        self.assertNotIn("seed", body)
        self.assertNotIn("n", body)
        self.assertNotIn("Generate the image with aspect ratio", body["prompt"])
        self.assertEqual(len(body["safety_identifier"]), 16)
        headers = self.fake.headers[0]
        self.assertEqual(headers["Authorization"], f"Bearer {API_KEY}")
        self.assertNotIn("X-Title", headers)
        self.assertIn("OpenAI does not support seeds: it was ignored.", snap["result"]["notes"])
        row = list(csv.DictReader((self.data_dir / audit.LOG_FILENAME).read_text().splitlines()))[-1]
        self.assertEqual(row["provider"], "openai")

    def test_images_go_to_edits_as_multipart(self):
        files = [("files", ("ref.png", tiny_png(), "image/png")),
                 ("guide", ("guide.png", tiny_png(6, 4), "image/png"))]
        job_id = self.generate(provider="openai", files=files, fixed_panels="1", model="gpt-image-2").json()["job_id"]
        self.assertEqual(self.wait_job(job_id)["status"], "done")
        self.assertEqual(self.fake.urls[0], core.OPENAI_EDITS_URL)
        self.assertTrue(self.fake.headers[0]["Content-Type"].startswith("multipart/form-data; boundary="))
        parts = self.parts(self.fake.bodies[0])
        names = [name for name, _ in parts]
        self.assertEqual(names.count("image[]"), 2)
        images = [value for name, value in parts if name == "image[]"]
        self.assertEqual(images[0], tiny_png(6, 4))  # the layout guide goes first
        self.assertEqual(dict(parts)["model"], b"gpt-image-2")
        self.assertIn(b"layout guide", dict(parts)["prompt"])

    def test_retouch_sends_panel_and_marks(self):
        res = self.edit(provider="openai", mark_color="blue", area="10,10,50,50")
        snap = self.wait_job(res.json()["job_id"])
        self.assertEqual(snap["status"], "done", snap)
        self.assertEqual(self.fake.urls[0], core.OPENAI_EDITS_URL)
        parts = self.parts(self.fake.bodies[0])
        self.assertEqual([n for n, _ in parts].count("image[]"), 2)
        self.assertIn(b"with blue marks", dict(parts)["prompt"])
        self.assertEqual(dict(parts)["size"], b"1360x768")  # 16:9 panel at 1K

    def test_retouch_keeps_the_exact_panel_shape(self):
        # a 3:4-ish panel (600x800 would be 3:4; 594x800 is not a listed ratio): no snapping to 3:4
        res = self.edit(provider="openai", panel=tiny_png(594, 800), marked=tiny_png(594, 800))
        snap = self.wait_job(res.json()["job_id"])
        self.assertEqual(snap["status"], "done", snap)
        size = dict(self.parts(self.fake.bodies[0]))["size"].decode()
        w, h = (int(n) for n in size.split("x"))
        self.assertAlmostEqual(w / h, 594 / 800, delta=0.02)

    def test_openai_size(self):
        for ratio in ("1:1", "16:9", "21:9", "2:3", "9:16"):
            for tier in ("512", "1K", "2K", "4K"):
                size, note = core.openai_size(ratio, tier, "gpt-image-2.5-flare")
                w, h = (int(n) for n in size.split("x"))
                self.assertEqual((w % 16, h % 16), (0, 0), size)
                self.assertTrue(655_360 <= w * h <= 8_294_400, size)
                self.assertLessEqual(max(w, h), 3840, size)
                self.assertAlmostEqual(w / h, core.parse_ratio(ratio), delta=0.05 * w / h)  # shape kept
                self.assertIsNone(note)
        size, note = core.openai_size("8:1", "1K", "gpt-image-2")
        w, h = (int(n) for n in size.split("x"))
        self.assertLessEqual(w / h, 3.0)
        self.assertIn("3:1", note)
        self.assertEqual(core.openai_size("auto", "1K", "gpt-image-2"), ("auto", None))
        self.assertEqual(core.openai_size("3:2", "2K", "gpt-image-1.5")[0], "1536x1024")
        size, note = core.openai_size("21:9", "1K", "gpt-image-1-mini")
        self.assertEqual(size, "1536x1024")
        self.assertIn("only makes", note)

    def test_openai_errors(self):
        cases = [
            (403, '{"error": {"message": "Your organization must be verified to use the model"}}', "verified"),
            (401, '{"error": {"message": "Incorrect API key provided"}}', "OpenAI rejected the API key"),
            (403, '{"error": {"message": "Project does not have access to model gpt-image-2.5-flare"}}',
             "does not have access to model gpt-image-2.5-flare"),
            (429, '{"error": {"code": "insufficient_quota", "message": "You exceeded your current quota"}}',
             "no credits left"),
            (400, '{"error": {"code": "moderation_blocked", "message": "Request blocked"}}', "content filter"),
        ]
        for status, raw, needle in cases:
            self.fake = FakeOpenRouter(status=status, raw=raw)
            snap = self.wait_job(self.generate(provider="openai").json()["job_id"])
            self.assertEqual(snap["status"], "error", raw)
            self.assertIn(needle, snap["error"], raw)

    def test_no_access_is_not_a_rejected_key(self):
        # a valid key without access to the model must not lock the visitor out
        self.rebuild(generate_per_minute=0, auth_failures_before_lock=2)
        self.fake = FakeOpenRouter(status=403, raw='{"error": {"message": "You do not have access to this model"}}')
        for _ in range(3):
            snap = self.wait_job(self.generate(provider="openai").json()["job_id"])
            self.assertIn("accepted the key but refused", snap["error"])
            self.assertIn("Provider says: You do not have access to this model", snap["error"])
        self.assertEqual(self.generate(provider="openai").status_code, 200)

    def test_unknown_provider(self):
        res = self.generate(provider="gemini")
        self.assertEqual(res.status_code, 400)
        self.assertIn("provider", res.json()["detail"])
        self.assertEqual(self.edit(provider="gemini").status_code, 400)


class DebugDumpTests(ApiTestCase, unittest.TestCase):
    """Development only: off by default, never with a PUBLIC_URL, and never keeps the key."""

    def test_off_by_default(self):
        self.assertFalse(self.client.get("/api/meta").json()["debug"])
        self.wait_job(self.generate().json()["job_id"])
        self.assertFalse(any(self.data_dir.glob("debug*")))
        self.assertEqual(self.client.post("/api/debug/" + "0" * 32).status_code, 404)

    def test_never_with_public_url(self):
        self.rebuild(debug_dump_dir=self.data_dir / "debug", public_url="https://example.org")
        self.assertFalse(self.client.get("/api/meta").json()["debug"])
        self.wait_job(self.generate().json()["job_id"])
        self.assertFalse((self.data_dir / "debug").exists())

    def test_keeps_request_images_and_answer(self):
        self.rebuild(debug_dump_dir=self.data_dir / "debug")
        self.assertTrue(self.client.get("/api/meta").json()["debug"])
        guide = [("guide", ("guide.png", tiny_png(6, 4), "image/png"))]
        job_id = self.generate(files=guide, fixed_panels="1", prompt="A cat.").json()["job_id"]
        self.assertEqual(self.wait_job(job_id)["status"], "done")
        [folder] = (self.data_dir / "debug").iterdir()
        info = json.loads((folder / "request.json").read_text())
        self.assertEqual(info["mode"], "storyboard")
        self.assertEqual(info["sent"]["url"], core.OPENROUTER_IMAGES_URL)
        self.assertIn("Story:\nA cat.", (folder / "prompt.txt").read_text())
        self.assertEqual((folder / "sent" / "0_guide.png").read_bytes(), tiny_png(6, 4))
        self.assertEqual((folder / "answer.png").read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        everything = b"".join(f.read_bytes() for f in folder.rglob("*") if f.is_file())
        self.assertNotIn(API_KEY.encode(), everything)
        # the browser's side lands in the same folder
        res = self.client.post(f"/api/debug/{job_id}", files=[
            ("files", ("board.png", tiny_png(), "image/png")), ("note", (None, '{"shift": [0, 0]}'))])
        self.assertEqual(res.json(), {"saved": 1})
        self.assertTrue((folder / "browser" / "board.png").exists())
        self.assertEqual(self.client.post("/api/debug/" + "1" * 32, files=[("note", (None, "x"))]).status_code, 404)


class FakeModelTests(ApiTestCase, unittest.TestCase):
    """Development only: simulated images, no provider call, never with a PUBLIC_URL."""

    def test_off_by_default(self):
        self.assertFalse(self.client.get("/api/meta").json()["fake_model"])
        self.wait_job(self.generate().json()["job_id"])
        self.assertEqual(len(self.fake.bodies), 1)  # the (patched) provider was called

    def test_never_with_public_url(self):
        self.rebuild(fake_model=True, public_url="https://example.org")
        self.assertFalse(self.client.get("/api/meta").json()["fake_model"])
        self.wait_job(self.generate().json()["job_id"])
        self.assertEqual(len(self.fake.bodies), 1)

    def test_generate_and_retouch_without_any_provider(self):
        self.rebuild(fake_model=True)
        self.assertTrue(self.client.get("/api/meta").json()["fake_model"])
        job_id = self.generate(aspect_ratio="21:9", layout="1x3").json()["job_id"]
        snap = self.wait_job(job_id)
        self.assertEqual(snap["status"], "done", snap)
        self.assertEqual((snap["result"]["width"], snap["result"]["height"]), (1024, 439))
        self.assertIn("Fake model", snap["result"]["notes"][0])
        image = self.client.get(f"/api/jobs/{job_id}/image")
        self.assertEqual(image.content[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(core.sniff_image(image.content), ("image/png", 1024, 439))
        snap = self.wait_job(self.edit(panel=tiny_png(30, 40), marked=tiny_png(30, 40)).json()["job_id"])
        self.assertEqual(snap["status"], "done", snap)
        self.assertEqual(snap["result"]["width"] / snap["result"]["height"], 768 / 1024)
        self.assertEqual(self.wait_job(self.generate(key=None).json()["job_id"])["status"], "done")  # no key needed
        self.assertEqual(self.fake.bodies, [])  # nothing reached any provider
        self.assertEqual(self.fake.get_urls, [])


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
