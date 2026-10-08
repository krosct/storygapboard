"""Abuse protection and HTTP hardening.

- SlidingWindowLimiter: per-client request budgets (whole API and generations).
- FailureLock: locks a client out after repeated API-key rejections, so the
  site cannot be used as an oracle to brute-force or validate stolen keys.
- ASGI middlewares: security headers, body size cap, API rate limit and a
  same-origin check for state-changing requests. They are plain ASGI (not
  BaseHTTPMiddleware) so Server-Sent Events stream untouched.
"""

from __future__ import annotations

import json
import math
import threading
import time
from collections import deque
from typing import Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])

SECURITY_HEADERS = [
    (b"content-security-policy", CSP.encode()),
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
]

_SWEEP_EVERY_S = 60.0


class SlidingWindowLimiter:
    """At most `limit` hits per `window_s` seconds per key (limit 0 = unlimited)."""

    def __init__(self, limit: int, window_s: float) -> None:
        self.limit = limit
        self.window_s = window_s
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        self._last_sweep = time.monotonic()

    def _trim(self, hits: deque[float], now: float) -> None:
        while hits and now - hits[0] >= self.window_s:
            hits.popleft()

    def retry_after(self, key: str, now: float | None = None) -> float:
        """Seconds until a hit would be allowed (0 = allowed now). Does not record."""
        if self.limit <= 0:
            return 0.0
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits.get(key)
            if not hits:
                return 0.0
            self._trim(hits, now)
            if len(hits) < self.limit:
                return 0.0
            return max(0.0, self.window_s - (now - hits[0]))

    def hit(self, key: str, now: float | None = None) -> float:
        """Record a hit when allowed. Returns 0 if allowed, else seconds to wait."""
        if self.limit <= 0:
            return 0.0
        now = time.monotonic() if now is None else now
        with self._lock:
            self._sweep(now)
            hits = self._hits.setdefault(key, deque())
            self._trim(hits, now)
            if len(hits) >= self.limit:
                return max(0.0, self.window_s - (now - hits[0]))
            hits.append(now)
            return 0.0

    def _sweep(self, now: float) -> None:
        # Bounded memory: drop clients with no hit inside the window.
        if now - self._last_sweep < _SWEEP_EVERY_S:
            return
        self._last_sweep = now
        for key in [k for k, v in self._hits.items() if not v or now - v[-1] >= self.window_s]:
            del self._hits[key]


class FailureLock:
    """Lock a key for `lock_s` after `threshold` failures inside `window_s`."""

    def __init__(self, threshold: int, window_s: float, lock_s: float) -> None:
        self.threshold = threshold
        self._failures = SlidingWindowLimiter(max(threshold, 1), window_s)
        self.lock_s = lock_s
        self._locked_until: dict[str, float] = {}
        self._lock = threading.Lock()

    def locked_for(self, key: str, now: float | None = None) -> float:
        if self.threshold <= 0:
            return 0.0
        now = time.monotonic() if now is None else now
        with self._lock:
            until = self._locked_until.get(key, 0.0)
            if until <= now:
                self._locked_until.pop(key, None)
                return 0.0
            return until - now

    def record_failure(self, key: str, now: float | None = None) -> bool:
        """Count one failure. Returns True when this failure triggers the lock."""
        if self.threshold <= 0:
            return False
        now = time.monotonic() if now is None else now
        # hit() records the failure while under the threshold; the budget being
        # exhausted (now or already) means the threshold was reached.
        refused = self._failures.hit(key, now) > 0
        if not refused and self._failures.retry_after(key, now) == 0:
            return False
        with self._lock:
            for stale in [k for k, v in self._locked_until.items() if v <= now]:
                del self._locked_until[stale]
            self._locked_until[key] = now + self.lock_s
        return True


def client_ip(scope: Scope) -> str:
    """Client address (already resolved from X-Forwarded-For by uvicorn's
    proxy-headers middleware, which only trusts FORWARDED_ALLOW_IPS)."""
    client = scope.get("client")
    return client[0] if client else "unknown"


def _header(scope: Scope, name: bytes) -> str:
    for key, value in scope.get("headers") or []:
        if key == name:
            return value.decode("latin-1")
    return ""


async def send_json(send: Send, status: int, detail: str,
                    extra_headers: list[tuple[bytes, bytes]] | None = None) -> None:
    body = json.dumps({"detail": detail}).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
               (b"cache-control", b"no-store")] + (extra_headers or [])
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


def retry_after_header(seconds: float) -> list[tuple[bytes, bytes]]:
    return [(b"retry-after", str(max(1, math.ceil(seconds))).encode())]


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        is_api = path.startswith("/api/")
        # Vite build output: file names carry a content hash, so they never change.
        is_asset = path.startswith("/assets/")
        # Behind the proxy, uvicorn --proxy-headers sets the scheme from X-Forwarded-Proto.
        is_https = scope.get("scheme") == "https"

        async def wrapped(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", [])
                           if k.lower() not in (b"server", b"x-powered-by")]
                headers += SECURITY_HEADERS
                if is_https:
                    headers.append((b"strict-transport-security", b"max-age=31536000"))
                if not any(k.lower() == b"cache-control" for k, _ in headers):
                    if is_api:
                        headers.append((b"cache-control", b"no-store"))
                    elif is_asset and message["status"] == 200:
                        headers.append((b"cache-control", b"public, max-age=31536000, immutable"))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, wrapped)


class BodySizeLimitMiddleware:
    """413 when the body exceeds max_bytes (declared length or actually streamed)."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = _header(scope, b"content-length")
        if declared.isdigit() and int(declared) > self.max_bytes:
            await send_json(send, 413, "The upload is too large (max 5 files of 5 MB each).")
            return
        received = 0

        async def limited() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise BodyTooLarge()
            return message

        try:
            await self.app(scope, limited, send)
        except BodyTooLarge:
            await send_json(send, 413, "The upload is too large (max 5 files of 5 MB each).")


class BodyTooLarge(Exception):
    pass


class ApiRateLimitMiddleware:
    """Per-client budget for every /api/ request (health checks excluded)."""

    def __init__(self, app: ASGIApp, limiter: SlidingWindowLimiter,
                 on_limited: Callable[[str, str], None] | None = None) -> None:
        self.app = app
        self.limiter = limiter
        self.on_limited = on_limited

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/") or path == "/api/health":
            await self.app(scope, receive, send)
            return
        ip = client_ip(scope)
        wait = self.limiter.hit(ip)
        if wait > 0:
            if self.on_limited:
                self.on_limited(ip, path)
            await send_json(send, 429, "Too many requests. Slow down and try again shortly.",
                            retry_after_header(wait))
            return
        await self.app(scope, receive, send)


class SameOriginMiddleware:
    """Reject cross-site state-changing API calls (Origin must match Host)."""

    SAFE = {"GET", "HEAD", "OPTIONS"}

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (scope["type"] == "http" and scope.get("method") not in self.SAFE
                and scope.get("path", "").startswith("/api/")):
            origin = _header(scope, b"origin")
            host = _header(scope, b"host")
            if origin and origin.split("://", 1)[-1] != host:
                await send_json(send, 403, "Cross-site requests are not allowed.")
                return
        await self.app(scope, receive, send)
