"""Shared fixtures: a fake OpenRouter (no network, no cost) and tiny images."""

from __future__ import annotations

import base64
import json
import struct
import tempfile
import threading
import time
import zlib
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from app import core
from app.main import create_app
from app.settings import Settings

API_KEY = "sk-or-test-0123456789abcdef"


def tiny_png(width: int = 2, height: int = 3) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    raw = (b"\x00" + b"\x80\x80\x80" * width) * height
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class FakeOpenRouter:
    """Replaces core._http. Records the bodies sent to the images endpoint."""

    def __init__(self, caps: dict | None = None, status: int = 200, raw: str | None = None,
                 delay_s: float = 0.0) -> None:
        self.caps = caps
        self.status = status
        self.raw = raw
        self.delay_s = delay_s
        self.bodies: list[dict] = []
        self.headers: list[dict] = []
        self.get_urls: list[str] = []
        self.lock = threading.Lock()

    def __call__(self, method, url, headers, body, timeout_s, token):
        if method == "GET":
            self.get_urls.append(url)
            if self.caps is None:
                return 404, "{}"
            return 200, json.dumps({"endpoints": [{"supported_parameters": self.caps}]})
        with self.lock:
            self.bodies.append(body)
            self.headers.append(headers)
        waited = 0.0
        while waited < self.delay_s:
            token.check()
            time.sleep(0.02)
            waited += 0.02
        token.check()
        if self.raw is not None:
            return self.status, self.raw
        payload = {"data": [{"b64_json": base64.b64encode(tiny_png(4, 2)).decode()}],
                   "usage": {"cost": 0.0123}}
        return 200, json.dumps(payload)


class ApiTestCase:
    """Mixin: fresh app + temp data dir per test, with the fake provider patched in."""

    settings_overrides: dict = {}

    def setUp(self):  # noqa: D401 - unittest hook
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        core._CAPS_CACHE.clear()
        self.fake = FakeOpenRouter()
        patcher = mock.patch.object(core, "_http", side_effect=lambda *a: self.fake(*a))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.data_dir = Path(self._tmp.name)
        self.rebuild()

    def rebuild(self, **extra) -> None:
        """Fresh app (and fresh limiters) with settings overridden by extra."""
        self.app = create_app(self.make_settings(**extra))
        self.client = TestClient(self.app)

    def make_settings(self, **extra) -> Settings:
        values = dict(data_dir=self.data_dir, frontend_dist=self.data_dir / "no-dist",
                      log_hash_salt="test-salt", generate_per_minute=50, generate_per_day=500,
                      api_per_minute=1000)
        values.update(self.settings_overrides)
        values.update(extra)
        return Settings(**values)

    def generate(self, prompt="a red panda astronaut", files=None, key=API_KEY, **fields):
        data = {"prompt": prompt, "model": "", "aspect_ratio": "1:1", "layout": "2x3", "resolution": "1K",
                "output_format": "png", "seed": ""}
        data.update(fields)
        headers = {"X-Api-Key": key} if key is not None else {}
        # (None, value) parts are plain form fields: always multipart, even without files.
        parts = [(name, (None, value)) for name, value in data.items()] + list(files or [])
        return self.client.post("/api/generate", files=parts, headers=headers)

    def wait_job(self, job_id: str, timeout_s: float = 5.0) -> dict:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            job = self.app.state.jobs.get(job_id)
            if job is not None and job.status != "running":
                return job.snapshot()
            time.sleep(0.02)
        raise AssertionError("job did not finish")
