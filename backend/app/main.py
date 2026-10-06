"""StoryGapBoard web backend (FastAPI).

Public API (all under /api, JSON unless stated):
    GET  /api/health                 liveness probe
    GET  /api/meta                   options and limits for the UI
    POST /api/generate               multipart form + X-Api-Key header -> {job_id}
    GET  /api/jobs/{id}/events       Server-Sent Events with the job status
    POST /api/jobs/{id}/cancel       cancel a running job
    GET  /api/jobs/{id}/image        the generated image (kept in memory, TTL)

The visitor's OpenRouter key arrives per request and is never stored or
logged (only a salted hash goes to the server-side generation log).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import re
import threading

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import UploadFile

from . import core
from .audit import GenerationLog, salted_hash
from .jobs import Job, JobLimitError, JobStore
from .security import (
    ApiRateLimitMiddleware,
    BodySizeLimitMiddleware,
    FailureLock,
    SameOriginMiddleware,
    SecurityHeadersMiddleware,
    SlidingWindowLimiter,
    client_ip,
)
from .settings import Settings

logger = logging.getLogger("storygapboard")

JOB_ID_RE = re.compile(r"[0-9a-f]{32}")
SSE_INTERVAL_S = 0.5
SSE_MAX_SECONDS = core.REQUEST_TIMEOUT_S + core.CAPS_TIMEOUT_S * 2 + 60
FORM_FIELDS = ("prompt", "model", "aspect_ratio", "layout", "resolution", "output_format", "seed")


def _error(status: int, detail: str, retry_after: float | None = None) -> HTTPException:
    headers = {"Retry-After": str(max(1, int(retry_after + 0.999)))} if retry_after else None
    return HTTPException(status, detail, headers=headers)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    app = FastAPI(title="StoryGapBoard", docs_url=None, redoc_url=None, openapi_url=None)
    jobs = JobStore(settings.job_ttl_s, settings.max_stored_jobs,
                    settings.max_concurrent_jobs, settings.max_jobs_per_client)
    gen_minute = SlidingWindowLimiter(settings.generate_per_minute, 60)
    gen_day = SlidingWindowLimiter(settings.generate_per_day, 86400)
    auth_lock = FailureLock(settings.auth_failures_before_lock,
                            settings.auth_failure_window_s, settings.auth_lock_s)
    gen_log = GenerationLog(settings.data_dir)
    app.state.settings = settings
    app.state.jobs = jobs

    def client_id(ip: str) -> str:
        return salted_hash(settings.log_hash_salt, ip)

    def on_api_limited(ip: str, path: str) -> None:
        logger.warning("rate limited client=%s path=%s", client_id(ip), path)

    # Outermost first: headers wrap everything, then size cap, rate limit, origin check.
    app.add_middleware(SameOriginMiddleware)
    app.add_middleware(ApiRateLimitMiddleware,
                       limiter=SlidingWindowLimiter(settings.api_per_minute, 60),
                       on_limited=on_api_limited)
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_body_bytes)
    app.add_middleware(SecurityHeadersMiddleware)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_request: Request, _exc: RequestValidationError) -> JSONResponse:
        # Never echo the submitted values back.
        return JSONResponse({"detail": "Invalid request."}, status_code=400)

    # ------------------------------------------------------------------
    # Meta
    # ------------------------------------------------------------------

    @app.get("/api/health")
    def api_health() -> dict:
        return {"ok": True}

    @app.get("/api/meta")
    def api_meta() -> dict:
        return {
            "default_model": core.DEFAULT_MODEL,
            "aspect_ratios": core.ASPECT_RATIOS,
            "layouts": core.LAYOUTS,
            "default_layout": core.DEFAULT_LAYOUT,
            "resolutions": core.RESOLUTIONS,
            "output_formats": core.OUTPUT_FORMATS,
            "limits": {
                "max_files": core.MAX_UPLOAD_FILES,
                "max_file_bytes": core.MAX_UPLOAD_BYTES,
                "max_prompt_chars": core.MAX_PROMPT_CHARS,
                "generate_per_minute": settings.generate_per_minute,
                "generate_per_day": settings.generate_per_day,
            },
        }

    # ------------------------------------------------------------------
    # Generate
    # ------------------------------------------------------------------

    async def read_uploads(values: list) -> list[core.Upload]:
        if len(values) > core.MAX_UPLOAD_FILES:
            raise _error(400, f"You can upload at most {core.MAX_UPLOAD_FILES} files.")
        uploads = []
        for value in values:
            if not isinstance(value, UploadFile):
                raise _error(400, "Invalid file field.")
            data = await value.read(core.MAX_UPLOAD_BYTES + 1)
            try:
                uploads.append(core.classify_upload(value.filename, data))
            except ValueError as exc:
                raise _error(400, str(exc)) from exc
        return uploads

    @app.post("/api/generate")
    async def api_generate(request: Request) -> dict:
        ip = client_ip(request.scope)
        locked = auth_lock.locked_for(ip)
        if locked:
            raise _error(429, "Too many rejected API keys from your connection. "
                              "Try again later.", locked)
        if not request.headers.get("content-type", "").startswith("multipart/form-data"):
            raise _error(415, "Send the form as multipart/form-data.")
        try:
            form = await request.form(max_files=core.MAX_UPLOAD_FILES, max_fields=16,
                                      max_part_size=64 * 1024)
        except HTTPException as exc:
            raise _error(400, f"Invalid upload: you can send at most {core.MAX_UPLOAD_FILES} "
                              "files and short text fields.") from exc
        try:
            fields = {name: form.get(name) for name in FORM_FIELDS}
            if any(v is not None and not isinstance(v, str) for v in fields.values()):
                raise ValueError("Invalid form field.")
            req = core.GenerationRequest(
                prompt=core.validate_prompt(fields["prompt"]),
                model=core.validate_model(fields["model"]),
                aspect_ratio=core.validate_choice(fields["aspect_ratio"], core.ASPECT_RATIOS, "aspect ratio"),
                layout=core.validate_choice(fields["layout"], core.LAYOUTS, "layout"),
                resolution=core.validate_choice(fields["resolution"], core.RESOLUTIONS, "resolution"),
                output_format=core.validate_choice(fields["output_format"], core.OUTPUT_FORMATS, "format"),
                seed=core.validate_seed(fields["seed"]),
                api_key=core.validate_api_key(request.headers.get("x-api-key")),
            )
            req.uploads = await read_uploads(form.getlist("files"))
        except ValueError as exc:
            raise _error(400, str(exc)) from exc
        finally:
            await form.close()
        wait = max(gen_minute.retry_after(ip), gen_day.retry_after(ip))
        if wait > 0:
            logger.warning("generate limit client=%s", client_id(ip))
            raise _error(429, "You reached the generation limit. Try again later.", wait)
        try:
            job = jobs.create(ip)
        except JobLimitError as exc:
            raise _error(exc.status, str(exc), 10) from exc
        gen_minute.hit(ip)
        gen_day.hit(ip)
        threading.Thread(target=run_job, args=(job, req), daemon=True,
                         name=f"job-{job.id[:8]}").start()
        return {"job_id": job.id}

    def log_row(job: Job, req: core.GenerationRequest, result: core.GenerationResult | None,
                status: str, error: str) -> dict:
        return {
            "status": status,
            "client_id": client_id(job.client),
            "key_hash": salted_hash(settings.log_hash_salt, req.api_key),
            "prompt": req.prompt,
            "context_files": sum(u.kind == "text" for u in req.uploads),
            "reference_images": sum(u.kind == "image" for u in req.uploads),
            "model": req.model,
            "aspect_ratio_req": req.aspect_ratio,
            "layout": req.layout,
            "resolution_req": req.resolution,
            "output_format_req": req.output_format,
            "seed": "" if req.seed is None else req.seed,
            "image_file": job.filename if result else "",
            "image_bytes": len(result.data) if result else "",
            "width": result.width if result else "",
            "height": result.height if result else "",
            "cost_usd": f"{result.cost:.6f}" if result else "",
            "total_seconds": f"{result.elapsed:.2f}" if result else "",
            "error": error,
        }

    def run_job(job: Job, req: core.GenerationRequest) -> None:
        status, error = "done", ""
        result = None
        try:
            result = core.generate(req, job.token, settings.public_url)
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d_%H%M%S")
            job.filename = f"image_{stamp}.{result.ext}"
        except core.GenerationCancelled:
            status = "cancelled"
        except core.ProviderAuthError as exc:
            status, error = "error", str(exc)
            if auth_lock.record_failure(job.client):
                logger.warning("auth lock client=%s", client_id(job.client))
        except core.ProviderError as exc:
            status, error = "error", str(exc)
        except Exception:  # noqa: BLE001 - details go to the server log only
            logger.exception("job %s failed", job.id[:8])
            status, error = "error", "Something went wrong on our side. Try again."
        try:
            gen_log.append(log_row(job, req, result, status, error))
        except OSError:
            logger.exception("could not write the generation log")
        finally:
            # Drop the key and the uploads as soon as they are no longer needed.
            req.api_key = ""
            req.uploads = []
        jobs.finish(job, status, result=result, error=error)
        logger.info("job %s %s", job.id[:8], status)

    # ------------------------------------------------------------------
    # Jobs
    # ------------------------------------------------------------------

    def job_or_404(job_id: str) -> Job:
        job = jobs.get(job_id) if JOB_ID_RE.fullmatch(job_id) else None
        if job is None:
            raise _error(404, "This generation expired or does not exist.")
        return job

    @app.get("/api/jobs/{job_id}/events")
    async def api_job_events(job_id: str, request: Request) -> StreamingResponse:
        job = job_or_404(job_id)

        async def stream():
            loop = asyncio.get_running_loop()
            deadline = loop.time() + SSE_MAX_SECONDS
            while True:
                snapshot = job.snapshot()
                yield f"data: {json.dumps(snapshot)}\n\n"
                if snapshot["status"] != "running" or loop.time() > deadline:
                    return
                if await request.is_disconnected():
                    return
                await asyncio.sleep(SSE_INTERVAL_S)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @app.post("/api/jobs/{job_id}/cancel")
    def api_cancel(job_id: str) -> dict:
        job = job_or_404(job_id)
        if job.status != "running":
            return {"cancelled": False, "status": job.status}
        job.token.cancel()
        return {"cancelled": True}

    @app.get("/api/jobs/{job_id}/image")
    def api_image(job_id: str) -> Response:
        job = job_or_404(job_id)
        if job.status != "done" or job.result is None:
            raise _error(404, "The image is not ready.")
        return Response(job.result.data, media_type=job.result.mime, headers={
            "Content-Disposition": f'inline; filename="{job.filename}"',
            "Cache-Control": "no-store",
        })

    # ------------------------------------------------------------------
    # Frontend (Vite build)
    # ------------------------------------------------------------------

    if settings.frontend_dist.is_dir():
        app.mount("/", StaticFiles(directory=settings.frontend_dist, html=True), name="frontend")
    else:
        logger.warning("frontend build not found at %s", settings.frontend_dist)

    return app


app = create_app()
