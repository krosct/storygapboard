"""Server-side generation log (CSV). Never exposed over HTTP.

Client IPs and API keys are stored only as salted hashes, so abuse can be
correlated without keeping the raw values. Cells are neutralised against
spreadsheet formula injection.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import hmac
import threading
from pathlib import Path

LOG_FILENAME = "generation_log.csv"
LOG_FIELDS = [
    "date",
    "status",
    "client_id",
    "key_hash",
    "prompt",
    "context_files",
    "reference_images",
    "model",
    "aspect_ratio_req",
    "layout",
    "resolution_req",
    "output_format_req",
    "seed",
    "image_file",
    "image_bytes",
    "width",
    "height",
    "cost_usd",
    "total_seconds",
    "error",
]
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def salted_hash(salt: str, value: str | None) -> str:
    if not value:
        return ""
    return hmac.new(salt.encode(), value.encode(), hashlib.sha256).hexdigest()[:16]


def _safe_cell(value: object) -> str:
    text = "" if value is None else str(value)
    if text.startswith(_FORMULA_PREFIXES):
        return "'" + text
    return text


class GenerationLog:
    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / LOG_FILENAME
        self._lock = threading.Lock()
        self._checked = False

    def _rotate_if_outdated(self) -> None:
        """Columns changed since the file was created: keep it aside, start a new one."""
        if self._checked or not self.path.exists():
            self._checked = True
            return
        with self.path.open("r", encoding="utf-8", newline="") as fh:
            header = next(csv.reader(fh), [])
        if header and header != LOG_FIELDS:
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
            self.path.rename(self.path.with_name(f"{self.path.stem}.{stamp}{self.path.suffix}"))
        self._checked = True

    def append(self, row: dict) -> None:
        entry = {name: _safe_cell(row.get(name, "")) for name in LOG_FIELDS}
        entry["date"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._rotate_if_outdated()
            new_file = not self.path.exists() or self.path.stat().st_size == 0
            with self.path.open("a", encoding="utf-8", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=LOG_FIELDS)
                if new_file:
                    writer.writeheader()
                writer.writerow(entry)
