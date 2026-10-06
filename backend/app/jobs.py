"""In-memory job store. A job is one generation; its image lives here until
the TTL expires (nothing is written to disk). Job ids are 128-bit random,
so knowing the id is the capability to read or cancel the job."""

from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field

from .core import CancelToken, GenerationResult


@dataclass
class Job:
    id: str
    client: str
    token: CancelToken = field(default_factory=CancelToken)
    status: str = "running"          # running | done | error | cancelled
    started: float = field(default_factory=time.monotonic)
    finished: float | None = None
    error: str = ""
    result: GenerationResult | None = None
    filename: str = ""

    def snapshot(self) -> dict:
        data: dict = {"status": self.status}
        if self.status == "running":
            data["elapsed"] = round(time.monotonic() - self.started, 1)
        elif self.status == "done" and self.result is not None:
            data["result"] = {
                "filename": self.filename,
                "width": self.result.width,
                "height": self.result.height,
                "bytes": len(self.result.data),
                "cost": round(self.result.cost, 6),
                "seed": self.result.seed,
                "elapsed": round(self.result.elapsed, 2),
                "notes": self.result.notes,
            }
        elif self.status == "error":
            data["error"] = self.error
        return data


class JobLimitError(Exception):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


class JobStore:
    def __init__(self, ttl_s: int, max_stored: int, max_running: int, max_per_client: int) -> None:
        self.ttl_s = ttl_s
        self.max_stored = max_stored
        self.max_running = max_running
        self.max_per_client = max_per_client
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, client: str) -> Job:
        """Reserve a running slot for the client, or raise JobLimitError."""
        with self._lock:
            self._expire()
            running = [j for j in self._jobs.values() if j.status == "running"]
            if self.max_per_client and sum(j.client == client for j in running) >= self.max_per_client:
                raise JobLimitError("You already have a generation running. Wait for it or cancel it.", 429)
            if self.max_running and len(running) >= self.max_running:
                raise JobLimitError("The server is busy right now. Try again in a minute.", 503)
            job = Job(id=secrets.token_hex(16), client=client)
            self._jobs[job.id] = job
            return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            self._expire()
            return self._jobs.get(job_id)

    def finish(self, job: Job, status: str, *, result: GenerationResult | None = None,
               error: str = "") -> None:
        with self._lock:
            # status last: readers treat status != "running" as "result is final"
            job.result = result
            job.error = error
            job.finished = time.monotonic()
            job.status = status

    def _expire(self) -> None:
        now = time.monotonic()
        for job_id in [j.id for j in self._jobs.values()
                       if j.finished is not None and now - j.finished > self.ttl_s]:
            del self._jobs[job_id]
        finished = sorted((j for j in self._jobs.values() if j.finished is not None),
                          key=lambda j: j.finished or 0)
        while len(self._jobs) > self.max_stored and finished:
            del self._jobs[finished.pop(0).id]
