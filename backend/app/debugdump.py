"""Development only: keep what each job sent and got back, to debug the image flow.

Off unless DEBUG_DUMP_DIR is set, and never when PUBLIC_URL is set (devkit sets it on
the server): production keeps no images, as the privacy rules say. When on, each job
gets a folder with the request (endpoint, final prompt, parameters; never the key),
the images sent, the model's raw answer, and what the browser made of it (posted to
/api/debug/{job_id}: the composed board, the retouch mask, the blended panel...).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import threading
from collections import OrderedDict
from pathlib import Path

from . import core

logger = logging.getLogger("storygapboard")

MAX_FOLDERS = 200
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str) -> str:
    return _SAFE_NAME.sub("_", name).strip("._")[:80] or "file"


class DebugDump:
    def __init__(self, root: Path | None, public_url: str = "") -> None:
        self.root = root if root and not public_url else None
        if root and public_url:
            logger.warning("DEBUG_DUMP_DIR ignored: PUBLIC_URL is set (debug dumps are for local development only)")
        elif self.root:
            logger.warning("DEBUG DUMP ON: requests and images are written to %s (local development only)", self.root)
        self._folders: OrderedDict[str, Path] = OrderedDict()
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.root is not None

    def job(self, job_id: str, req: core.GenerationRequest, result: core.GenerationResult | None,
            status: str, error: str) -> None:
        """Everything about one finished job: request, inputs, raw answer."""
        if not self.root:
            return
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        folder = self.root / f"{stamp}_{req.mode}_{job_id[:8]}"
        (folder / "sent").mkdir(parents=True, exist_ok=True)
        info = {
            "status": status, "error": error, "mode": req.mode, "provider": req.provider, "model": req.model,
            "visitor_prompt": req.prompt, "aspect_ratio": req.aspect_ratio, "layout": req.layout,
            "resolution": req.resolution, "output_format": req.output_format, "seed": req.seed,
            "fixed_panels": req.fixed_panels, "area": req.area, "mark_color": req.mark_color,
            "sent": {k: v for k, v in req.sent.items() if k != "prompt"},
        }
        if result:
            info["answer"] = {"mime": result.mime, "width": result.width, "height": result.height,
                              "cost": result.cost, "elapsed": round(result.elapsed, 2), "notes": result.notes}
        (folder / "request.json").write_text(json.dumps(info, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        (folder / "prompt.txt").write_text(req.sent.get("prompt", req.prompt) + "\n", encoding="utf-8")
        images = ([("guide", req.guide)] if req.guide else []) + [(u.name, u) for u in req.uploads]
        for i, (name, upload) in enumerate(images):
            if upload.kind == "image":
                ext = core.EXTENSIONS.get(upload.mime, "bin")
                (folder / "sent" / f"{i}_{safe_name(Path(name).stem)}.{ext}").write_bytes(upload.data)
            else:
                (folder / "sent" / f"{i}_{safe_name(name)}").write_text(upload.text, encoding="utf-8")
        if result:
            (folder / f"answer.{result.ext}").write_bytes(result.data)
        with self._lock:
            self._folders[job_id] = folder
            while len(self._folders) > MAX_FOLDERS:
                self._folders.popitem(last=False)

    def browser(self, job_id: str, files: list[tuple[str, bytes]], note: str) -> int:
        """What the browser did with a job's answer. Returns the number of files saved."""
        with self._lock:
            folder = self._folders.get(job_id)
        if not folder:
            raise KeyError(job_id)
        target = folder / "browser"
        target.mkdir(exist_ok=True)
        for name, data in files:
            (target / safe_name(name)).write_bytes(data)
        if note:
            (target / "note.json").write_text(note + "\n", encoding="utf-8")
        return len(files)
