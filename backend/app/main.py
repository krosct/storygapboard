"""StoryGapBoard web backend (FastAPI).

Public API (all under /api, JSON unless stated):
    GET  /api/health                 liveness probe
    GET  /api/meta                   options and limits for the UI
    POST /api/generate               multipart form + X-Api-Key header -> {job_id}
    POST /api/edit                   retouch one panel (panel + marked panel) -> {job_id}
    GET  /api/jobs/{id}/events       Server-Sent Events with the job status
    POST /api/jobs/{id}/cancel       cancel a running job
    GET  /api/jobs/{id}/image        the generated image (kept in memory, TTL)

The visitor's provider key (OpenRouter or OpenAI) arrives per request and is never stored or
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

from . import core, fakemodel
from .audit import GenerationLog, salted_hash
from .debugdump import DebugDump
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
FORM_FIELDS = ("prompt", "model", "aspect_ratio", "layout", "resolution", "output_format", "seed",
               "fixed_panels", "provider")
EDIT_FIELDS = ("prompt", "model", "resolution", "output_format", "seed", "area", "mark_color", "provider")


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
    debug = DebugDump(settings.debug_dump_dir, settings.public_url)
    # development only, never with a PUBLIC_URL (always set on the server)
    fake_model = settings.fake_model and not settings.public_url
    if settings.fake_model and settings.public_url:
        logger.warning("DEBUG_FAKE_MODEL ignored: PUBLIC_URL is set (the fake model is for local development only)")
    elif fake_model:
        logger.warning("FAKE MODEL ON: generations and retouches use simulated images, no provider is called")
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
            "providers": [{"id": key, **info} for key, info in core.PROVIDERS.items()],
            "default_provider": core.DEFAULT_PROVIDER,
            # Ratio = the panel shape (a short list); board_ratios = what the model may be asked for
            "aspect_ratios": core.PANEL_RATIOS,
            "board_ratios": core.ASPECT_RATIOS,
            "layouts": core.LAYOUTS,
            "default_layout": core.DEFAULT_LAYOUT,
            "resolutions": core.RESOLUTIONS,
            "output_formats": core.OUTPUT_FORMATS,
            # development debug dump on: the browser also posts what it made of each answer
            "debug": debug.enabled,
            # development fake model on: no provider is called (the UI says so)
            "fake_model": fake_model,
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

    def read_key(request: Request) -> str:
        # the fake model calls nobody: no key needed (one typed in is still validated)
        raw = request.headers.get("x-api-key")
        return core.validate_api_key(raw) if raw or not fake_model else "fake-model"

    def check_lock(ip: str) -> None:
        locked = auth_lock.locked_for(ip)
        if locked:
            raise _error(429, "Too many rejected API keys from your connection. "
                              "Try again later.", locked)

    async def read_form(request: Request, max_files: int):
        if not request.headers.get("content-type", "").startswith("multipart/form-data"):
            raise _error(415, "Send the form as multipart/form-data.")
        try:
            return await request.form(max_files=max_files, max_fields=16,
                                      max_part_size=64 * 1024)
        except HTTPException as exc:
            raise _error(400, f"Invalid upload: you can send at most {core.MAX_UPLOAD_FILES} "
                              "files and short text fields.") from exc

    def text_fields(form, names: tuple[str, ...]) -> dict:
        fields = {name: form.get(name) for name in names}
        if any(v is not None and not isinstance(v, str) for v in fields.values()):
            raise ValueError("Invalid form field.")
        return fields

    async def read_image(value, label: str) -> core.Upload:
        uploads = await read_uploads([value] if value is not None else [])
        if len(uploads) != 1 or uploads[0].kind != "image":
            raise ValueError(f"Invalid {label}.")
        return uploads[0]

    def start_job(ip: str, req: core.GenerationRequest) -> dict:
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

    @app.post("/api/generate")
    async def api_generate(request: Request) -> dict:
        ip = client_ip(request.scope)
        check_lock(ip)
        # +1: the optional layout guide (the grid with the visitor's fixed panels).
        form = await read_form(request, core.MAX_UPLOAD_FILES + 1)
        try:
            fields = text_fields(form, FORM_FIELDS)
            layout = core.validate_choice(fields["layout"], core.LAYOUTS, "layout")
            provider = core.validate_provider(fields["provider"])
            req = core.GenerationRequest(
                # optional: without a story the model completes one
                prompt=core.validate_prompt(fields["prompt"], required=False),
                model=core.validate_model(fields["model"], provider),
                provider=provider,
                safety_id=client_id(ip),
                aspect_ratio=core.validate_choice(fields["aspect_ratio"], core.ASPECT_RATIOS, "aspect ratio"),
                layout=layout,
                resolution=core.validate_choice(fields["resolution"], core.RESOLUTIONS, "resolution"),
                output_format=core.validate_choice(fields["output_format"], core.OUTPUT_FORMATS, "format"),
                seed=core.validate_seed(fields["seed"]),
                api_key=read_key(request),
                fixed_panels=core.validate_fixed_panels(fields["fixed_panels"], layout),
            )
            req.uploads = await read_uploads(form.getlist("files"))
            guide = form.get("guide")
            if req.fixed_panels:
                req.guide = await read_image(guide, "layout guide")
            elif guide is not None:
                raise ValueError("Invalid layout guide.")
        except ValueError as exc:
            raise _error(400, str(exc)) from exc
        finally:
            await form.close()
        return start_job(ip, req)

    @app.post("/api/edit")
    async def api_edit(request: Request) -> dict:
        ip = client_ip(request.scope)
        check_lock(ip)
        form = await read_form(request, 2)
        try:
            fields = text_fields(form, EDIT_FIELDS)
            provider = core.validate_provider(fields["provider"])
            req = core.GenerationRequest(
                prompt=core.validate_prompt(fields["prompt"]),
                model=core.validate_model(fields["model"], provider),
                provider=provider,
                safety_id=client_id(ip),
                aspect_ratio="auto",
                layout="",
                resolution=core.validate_choice(fields["resolution"], core.RESOLUTIONS, "resolution"),
                output_format=core.validate_choice(fields["output_format"], core.OUTPUT_FORMATS, "format"),
                seed=core.validate_seed(fields["seed"]),
                api_key=read_key(request),
                mode="edit",
                area=core.validate_area(fields["area"]),
                mark_color=core.validate_choice(fields["mark_color"] or "red", core.MARK_COLORS, "mark color"),
            )
            panel = await read_image(form.get("panel"), "panel image")
            marked = await read_image(form.get("marked"), "marked panel image")
            size = core.sniff_image(panel.data)[1:]
            if core.sniff_image(marked.data)[1:] != size:
                raise ValueError("The marked panel must have the same size as the panel.")
            # OpenAI takes any WxH: ask for the panel's exact shape, so the answer lines up with it
            req.aspect_ratio = f"{size[0]}:{size[1]}" if provider == "openai" else core.edit_aspect_ratio(*size)
            req.uploads = [panel, marked]
        except ValueError as exc:
            raise _error(400, str(exc)) from exc
        finally:
            await form.close()
        return start_job(ip, req)

    def log_row(job: Job, req: core.GenerationRequest, result: core.GenerationResult | None,
                status: str, error: str) -> dict:
        return {
            "status": status,
            "mode": req.mode,
            "provider": req.provider,
            "client_id": client_id(job.client),
            "key_hash": salted_hash(settings.log_hash_salt, req.api_key),
            "prompt": req.prompt,
            "context_files": sum(u.kind == "text" for u in req.uploads),
            "reference_images": sum(u.kind == "image" for u in req.uploads),
            "fixed_panels": " ".join(str(n) for n in req.fixed_panels),
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
            result = (fakemodel.generate(req, job.token) if fake_model
                      else core.generate(req, job.token, settings.public_url))
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d_%H%M%S")
            prefix = "panel" if req.mode == "edit" else "storyboard"
            job.filename = f"{prefix}_{stamp}.{result.ext}"
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
        try:
            debug.job(job.id, req, result, status, error)
        except OSError:
            logger.exception("could not write the debug dump")
        finally:
            # Drop the key and the uploads as soon as they are no longer needed.
            req.api_key = ""
            req.uploads = []
            req.guide = None
        jobs.finish(job, status, result=result, error=error)
        logger.info("job %s %s", job.id[:8], status)

    # ------------------------------------------------------------------
    # Jobs
    # ------------------------------------------------------------------

    if debug.enabled:
        @app.post("/api/debug/{job_id}")
        async def api_debug(job_id: str, request: Request) -> dict:
            """Development only (never registered in production): the browser's side of a job."""
            if not JOB_ID_RE.fullmatch(job_id):
                raise _error(404, "Unknown job.")
            form = await read_form(request, 8)
            try:
                files = []
                for value in form.getlist("files"):
                    if not isinstance(value, UploadFile):
                        raise _error(400, "Invalid file field.")
                    files.append((value.filename or "file", await value.read(core.MAX_UPLOAD_BYTES * 2)))
                note = form.get("note")
                saved = debug.browser(job_id, files, note if isinstance(note, str) else "")
            except KeyError as exc:
                raise _error(404, "Unknown job.") from exc
            finally:
                await form.close()
            return {"saved": saved}

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
