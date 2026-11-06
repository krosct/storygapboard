"""Runtime settings, read from environment variables (see .env.example)."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer, got {raw!r}") from exc


@dataclass
class Settings:
    # Folder for the server-side generation log (data/ in the project folder).
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("DATA_DIR", "data")))
    # Built frontend (Vite output), shipped inside each release.
    frontend_dist: Path = field(default_factory=lambda: Path(
        os.environ.get("FRONTEND_DIST", str(BACKEND_DIR.parent / "frontend" / "dist"))))
    # Public site URL, sent to OpenRouter as HTTP-Referer (optional).
    public_url: str = field(default_factory=lambda: os.environ.get("PUBLIC_URL", "").strip())
    # Address shown to visitors for bug reports and feedback (optional; the UI hides the link when unset).
    contact_email: str = field(default_factory=lambda: os.environ.get("CONTACT_EMAIL", "").strip())
    # Salt for the hashed client/key ids in the log. Random per process when unset,
    # so set it in production to correlate abuse across restarts.
    log_hash_salt: str = field(default_factory=lambda: (
        os.environ.get("LOG_HASH_SALT", "").strip() or secrets.token_hex(16)))

    # Abuse protection (per client IP unless stated otherwise).
    api_per_minute: int = field(default_factory=lambda: _int("RATE_API_PER_MINUTE", 120))
    generate_per_minute: int = field(default_factory=lambda: _int("RATE_GENERATE_PER_MINUTE", 4))
    generate_per_day: int = field(default_factory=lambda: _int("RATE_GENERATE_PER_DAY", 100))
    max_jobs_per_client: int = field(default_factory=lambda: _int("MAX_JOBS_PER_CLIENT", 1))
    max_concurrent_jobs: int = field(default_factory=lambda: _int("MAX_CONCURRENT_JOBS", 4))
    auth_failures_before_lock: int = field(default_factory=lambda: _int("AUTH_FAILURES_BEFORE_LOCK", 5))
    auth_failure_window_s: int = field(default_factory=lambda: _int("AUTH_FAILURE_WINDOW_S", 900))
    auth_lock_s: int = field(default_factory=lambda: _int("AUTH_LOCK_S", 1800))

    # Finished jobs (and their image) are dropped after this many seconds.
    job_ttl_s: int = field(default_factory=lambda: _int("JOB_TTL_S", 900))
    max_stored_jobs: int = field(default_factory=lambda: _int("MAX_STORED_JOBS", 64))
    # Development only: keep every job's request, images and raw answer in this folder (off when
    # empty, and ignored whenever PUBLIC_URL is set, as on the server). See app/debugdump.py.
    debug_dump_dir: Path | None = field(default_factory=lambda: (
        Path(os.environ["DEBUG_DUMP_DIR"]) if os.environ.get("DEBUG_DUMP_DIR", "").strip() else None))
    # Development only: a simulated image model (no provider is called, nothing is spent), to try
    # the whole flow for free. Ignored whenever PUBLIC_URL is set, as on the server. See app/fakemodel.py.
    fake_model: bool = field(default_factory=lambda: (
        os.environ.get("DEBUG_FAKE_MODEL", "").strip().lower() in ("1", "true", "yes", "on")))
    # Whole request body cap (5 files + layout guide x 5 MB + form fields + multipart overhead).
    max_body_bytes: int = 32 * 1024 * 1024
