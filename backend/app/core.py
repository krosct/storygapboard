"""Image generation core: one OpenRouter request per generation.

Trimmed for a public web app:
OpenRouter only, exactly one image per generation, uploads held in memory,
and cancellation scoped to a single job (one visitor's Cancel never aborts
another visitor's request).
"""

from __future__ import annotations

import base64
import http.client
import json
import math
import re
import socket
import struct
import threading
import time
import urllib.parse
from collections import OrderedDict
from dataclasses import dataclass, field

OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images"
OPENROUTER_MODEL_ENDPOINTS_URL = "https://openrouter.ai/api/v1/images/models/{model}/endpoints"
DEFAULT_MODEL = "meta/muse-image"
APP_TITLE = "StoryGapBoard"

ASPECT_RATIOS = [
    "auto", "1:1", "1:2", "1:4", "1:8", "2:1", "2:3", "3:2", "3:4",
    "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9",
    "9:19.5", "19.5:9", "9:20", "20:9", "9:21", "21:9",
]
RESOLUTIONS = ["512", "1K", "2K", "4K"]
OUTPUT_FORMATS = ["png", "jpeg", "webp"]
# Storyboard grid as "<rows>x<columns>" (2x3 = 2 rows, 3 columns).
LAYOUTS = ["1x3", "1x6", "2x1", "2x2", "2x3", "3x1", "3x2"]
DEFAULT_LAYOUT = "2x3"

MAX_PROMPT_CHARS = 4000
MAX_CONTEXT_CHARS = 20000
MAX_UPLOAD_FILES = 5
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
TEXT_EXTS = (".txt", ".md")
MAX_SEED = 2**32 - 1
MAX_API_KEY_CHARS = 512
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}")
API_KEY_RE = re.compile(r"[\x21-\x7e]{8,%d}" % MAX_API_KEY_CHARS)

REQUEST_TIMEOUT_S = 300
CAPS_TIMEOUT_S = 15
MAX_RESPONSE_BYTES = 96 * 1024 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024


# ---------------------------------------------------------------------------
# Errors (messages are user-facing: English, no internals)
# ---------------------------------------------------------------------------

class GenerationCancelled(Exception):
    """The visitor cancelled the job."""


class ProviderError(RuntimeError):
    """The provider refused or failed the request. The message is safe to show."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class ProviderAuthError(ProviderError):
    """The provider rejected the API key (counts towards the brute-force lockout)."""


class ContentPolicyError(ProviderError):
    """The provider's content filter blocked the prompt."""


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

def validate_api_key(raw: str | None) -> str:
    key = (raw or "").strip()
    if not key:
        raise ValueError("Add your OpenRouter API key in the Model section first.")
    if not API_KEY_RE.fullmatch(key):
        raise ValueError("The API key format is not valid.")
    return key


def validate_model(raw: str | None) -> str:
    model = (raw or "").strip() or DEFAULT_MODEL
    if not MODEL_RE.fullmatch(model):
        raise ValueError("The model name is not valid (example: meta/muse-image).")
    return model


def validate_prompt(raw: str | None) -> str:
    prompt = (raw or "").strip()
    if not prompt:
        raise ValueError("Type a prompt first.")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(f"The prompt is too long (max {MAX_PROMPT_CHARS} characters).")
    return prompt


def validate_choice(raw: str | None, options: list[str], label: str) -> str:
    value = (raw or "").strip()
    if value not in options:
        raise ValueError(f"Invalid {label}.")
    return value


def validate_seed(raw: str | None) -> int | None:
    text = (raw or "").strip()
    if not text:
        return None
    if not text.isdigit() or int(text) > MAX_SEED:
        raise ValueError(f"The seed must be a whole number from 0 to {MAX_SEED}.")
    return int(text)


# ---------------------------------------------------------------------------
# Images (hand-rolled header parsing, no Pillow)
# ---------------------------------------------------------------------------

def png_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", raw[16:24])


def jpeg_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 4 or raw[:2] != b"\xff\xd8":
        return None
    i = 2
    sof_markers = set(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
    while i + 4 < len(raw):
        if raw[i] != 0xFF:
            i += 1
            continue
        marker = raw[i + 1]
        if marker == 0xD9:
            return None
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        size = struct.unpack(">H", raw[i + 2:i + 4])[0]
        if marker in sof_markers and i + 9 < len(raw):
            height, width = struct.unpack(">HH", raw[i + 5:i + 9])
            return width, height
        i += 2 + size
    return None


def webp_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 16 or raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
        return None
    kind = raw[12:16]
    if kind == b"VP8 " and len(raw) >= 30:
        width = struct.unpack("<H", raw[26:28])[0] & 0x3FFF
        height = struct.unpack("<H", raw[28:30])[0] & 0x3FFF
        return width, height
    if kind == b"VP8L" and len(raw) >= 25:
        b0, b1, b2, b3 = raw[21], raw[22], raw[23], raw[24]
        width = 1 + (((b1 & 0x3F) << 8) | b0)
        height = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
        return width, height
    if kind == b"VP8X" and len(raw) >= 30:
        width = 1 + int.from_bytes(raw[24:27], "little")
        height = 1 + int.from_bytes(raw[27:30], "little")
        return width, height
    return None


def gif_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) >= 10 and raw[:6] in (b"GIF87a", b"GIF89a"):
        return struct.unpack("<HH", raw[6:10])
    return None


def sniff_image(raw: bytes) -> tuple[str, int, int] | None:
    """(mime, width, height) from the file's magic bytes, else None."""
    for mime, parse in (("image/png", png_dimensions), ("image/jpeg", jpeg_dimensions),
                        ("image/webp", webp_dimensions), ("image/gif", gif_dimensions)):
        dims = parse(raw)
        if dims:
            return mime, dims[0], dims[1]
    return None


EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}


# ---------------------------------------------------------------------------
# Uploads: up to MAX_UPLOAD_FILES files, text -> context, images -> references
# ---------------------------------------------------------------------------

_UNSAFE_NAME_CHARS = re.compile(r"[\x00-\x1f\x7f/\\]")


def clean_filename(name: str | None) -> str:
    base = (name or "file").replace("\\", "/").rsplit("/", 1)[-1]
    base = _UNSAFE_NAME_CHARS.sub("_", base).strip() or "file"
    return base[:100]


@dataclass
class Upload:
    name: str
    kind: str          # "text" | "image"
    text: str = ""
    data: bytes = b""
    mime: str = ""


def classify_upload(name: str | None, data: bytes) -> Upload:
    """Validate one uploaded file. Raises ValueError with a user-facing message."""
    clean = clean_filename(name)
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError(f"{clean} is larger than 5 MB.")
    if not data:
        raise ValueError(f"{clean} is empty.")
    sniffed = sniff_image(data)
    if sniffed:
        return Upload(name=clean, kind="image", data=data, mime=sniffed[0])
    if clean.lower().endswith(TEXT_EXTS):
        if b"\x00" in data:
            raise ValueError(f"{clean} is not a plain text file.")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(f"{clean} must be UTF-8 text.") from exc
        return Upload(name=clean, kind="text", text=text)
    raise ValueError(f"{clean}: only PNG, JPEG, WebP, GIF, .txt and .md files are accepted.")


def context_text(uploads: list[Upload]) -> str:
    parts = [f"=== {u.name} ===\n{u.text.strip()}" for u in uploads if u.kind == "text"]
    combined = "\n\n".join(parts).strip()
    if len(combined) > MAX_CONTEXT_CHARS:
        combined = combined[:MAX_CONTEXT_CHARS] + "\n[context truncated]"
    return combined


def reference_images(uploads: list[Upload]) -> list[dict]:
    refs = []
    for u in uploads:
        if u.kind == "image":
            b64 = base64.b64encode(u.data).decode("ascii")
            refs.append({"type": "image_url", "image_url": {"url": f"data:{u.mime};base64,{b64}"}})
    return refs


def parse_layout(layout: str) -> tuple[int, int]:
    rows, cols = (int(n) for n in layout.split("x", 1))
    return rows, cols


def _plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def storyboard_instruction(layout: str) -> str:
    """Fixed instruction sent before every visitor prompt: the app makes storyboards."""
    rows, cols = parse_layout(layout)
    return (
        "You are a storyboard artist. Create ONE single image: a storyboard grid with exactly "
        f"{_plural(rows, 'row')} and {_plural(cols, 'column')} ({rows * cols} panels in total, "
        f"{rows} x {cols}). Panels are equal in size, separated by thin clear borders, and read "
        "left to right, top to bottom. Each panel shows the next moment of the story below, "
        "keeping the same characters, style and setting across panels. Use the context and "
        "reference images, if any, for characters and style. No captions, speech bubbles or "
        "panel numbers unless the story asks for them."
    )


def build_final_prompt(base_prompt: str, context: str, prop: str, resolution: str,
                       caps: dict | None = None, layout: str = DEFAULT_LAYOUT) -> str:
    """Storyboard instruction + the visitor's story, then context and the size hint
    (skipped when the API carries that parameter)."""
    chunks = [storyboard_instruction(layout), f"Story:\n{base_prompt.strip()}"]
    if context:
        chunks.append(f"Context:\n{context}")
    if prop and prop != "auto" and (caps is None or "aspect_ratio" not in caps):
        chunks.append(f"Generate the image with aspect ratio {prop}.")
    if resolution and (caps is None or "resolution" not in caps):
        chunks.append(f"Generate the image at resolution tier {resolution}.")
    return "\n\n".join(c for c in chunks if c)


# ---------------------------------------------------------------------------
# HTTP with per-job cancellation
# ---------------------------------------------------------------------------

class CancelToken:
    """Cancellation for ONE job: sets its flag and closes only its own sockets."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._conns: set[http.client.HTTPConnection] = set()

    def is_set(self) -> bool:
        return self._event.is_set()

    def check(self) -> None:
        if self._event.is_set():
            raise GenerationCancelled()

    def register(self, conn: http.client.HTTPConnection) -> None:
        with self._lock:
            self._conns.add(conn)

    def discard(self, conn: http.client.HTTPConnection) -> None:
        with self._lock:
            self._conns.discard(conn)

    def cancel(self) -> None:
        self._event.set()
        with self._lock:
            conns = list(self._conns)
        for conn in conns:
            sock = getattr(conn, "sock", None)
            if sock is not None:
                try:
                    # shutdown() releases a thread blocked in recv(); close() alone does not.
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - best effort
                pass


def _http(method: str, url: str, headers: dict, body: dict | None, timeout_s: int,
          token: CancelToken) -> tuple[int, str]:
    """Send one request and return (status, text). Raises GenerationCancelled on cancel."""
    parts = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.hostname or "", parts.port, timeout=timeout_s)
    token.register(conn)
    try:
        token.check()
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read(MAX_RESPONSE_BYTES + 1)
        token.check()
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ProviderError("The provider response was too large.")
        return resp.status, raw.decode("utf-8", errors="replace")
    except (OSError, http.client.HTTPException) as exc:
        if token.is_set():
            raise GenerationCancelled() from exc
        if isinstance(exc, (socket.timeout, TimeoutError)):
            raise ProviderError("The provider took too long to answer. Try again.") from exc
        raise ProviderError("Could not reach the provider. Try again in a moment.") from exc
    finally:
        token.discard(conn)
        try:
            conn.close()
        except Exception:  # noqa: BLE001 - best effort
            pass


def openrouter_headers(api_key: str, public_url: str = "") -> dict:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Title": APP_TITLE,
    }
    if public_url:
        headers["HTTP-Referer"] = public_url
    return headers


# ---------------------------------------------------------------------------
# Provider error mapping
# ---------------------------------------------------------------------------

_CONTENT_POLICY_MARKERS = (
    "content management policy", "content_policy", "content policy", "content filter",
    "filtered due to the prompt", "triggering our content", "moderation", "guardrail",
    "refusal", "refused", "moderation_blocked", "content_policy_violation",
    "prohibited_content",
)
_CAPABILITY_MISMATCH_MARKERS = (
    "supports the requested parameter",
    "filter by image capabilities",
)


def _provider_detail(raw: str, api_key: str) -> str:
    """Short provider message for the visitor (the key is redacted if echoed)."""
    detail = ""
    try:
        error = json.loads(raw).get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            detail = error["message"]
        elif isinstance(error, str):
            detail = error
    except (ValueError, AttributeError):
        detail = ""
    detail = " ".join((detail or raw or "").split())[:300]
    if api_key:
        detail = detail.replace(api_key, "[redacted]")
    return detail


def raise_for_status(status: int, raw: str, api_key: str, model: str) -> None:
    if status == 200:
        return
    detail = _provider_detail(raw, api_key)
    suffix = f" Provider says: {detail}" if detail else ""
    if status in (401, 403):
        raise ProviderAuthError(
            "OpenRouter rejected the API key. Check it in the Model section.", status)
    if status == 402:
        raise ProviderError("Your OpenRouter account has no credits left for this request.", status)
    if status == 404:
        raise ProviderError(f"OpenRouter does not know the model {model!r}.{suffix}", status)
    if status == 429:
        raise ProviderError("OpenRouter is rate limiting your key. Wait a bit and try again.", status)
    lowered = (raw or "").lower()
    if status == 400 and any(m in lowered for m in _CONTENT_POLICY_MARKERS):
        raise ContentPolicyError(
            "The provider's content filter blocked this request. Simplify the prompt, "
            "remove uploaded files, or try another model." + suffix, status)
    raise ProviderError(f"OpenRouter error (HTTP {status}).{suffix}", status)


def is_capability_mismatch(exc: ProviderError) -> bool:
    return exc.status == 400 and any(m in str(exc).lower() for m in _CAPABILITY_MISMATCH_MARKERS)


# ---------------------------------------------------------------------------
# Model capability discovery (keeps the app agnostic to the image model)
# ---------------------------------------------------------------------------

_CAPS_MAX_ENTRIES = 256
_CAPS_TTL_S = 3600
_CAPS_CACHE: OrderedDict[str, tuple[float, dict | None]] = OrderedDict()
_CAPS_LOCK = threading.Lock()


def model_capabilities(model: str, api_key: str, token: CancelToken,
                       refresh: bool = False, public_url: str = "") -> dict | None:
    """supported_parameters intersected across the model's endpoints (cached, bounded).

    None when unknown or the lookup fails: the request is then sent unchanged.
    """
    now = time.monotonic()
    with _CAPS_LOCK:
        cached = _CAPS_CACHE.get(model)
        if cached and not refresh and now - cached[0] < _CAPS_TTL_S:
            _CAPS_CACHE.move_to_end(model)
            return cached[1]
    # Keep "/" raw: OpenRouter answers 404 for "meta%2Fmuse-image".
    url = OPENROUTER_MODEL_ENDPOINTS_URL.format(model=urllib.parse.quote(model, safe="/"))
    caps: dict | None = None
    try:
        status, raw = _http("GET", url, openrouter_headers(api_key, public_url), None,
                            CAPS_TIMEOUT_S, token)
        if status == 200:
            endpoints = json.loads(raw).get("endpoints") or []
            param_sets = [ep["supported_parameters"] for ep in endpoints
                          if isinstance(ep, dict) and isinstance(ep.get("supported_parameters"), dict)]
            caps = intersect_capabilities(param_sets) or None
    except ProviderError:
        caps = None
    except (ValueError, AttributeError):
        caps = None
    with _CAPS_LOCK:
        _CAPS_CACHE[model] = (now, caps)
        _CAPS_CACHE.move_to_end(model)
        while len(_CAPS_CACHE) > _CAPS_MAX_ENTRIES:
            _CAPS_CACHE.popitem(last=False)
    return caps


def intersect_capabilities(param_sets: list[dict]) -> dict:
    if not param_sets:
        return {}
    merged: dict = dict(param_sets[0])
    for params in param_sets[1:]:
        for name in list(merged):
            if name not in params:
                del merged[name]
                continue
            merged[name] = _intersect_descriptors(merged[name], params[name])
            if merged[name] is None:
                del merged[name]
    return merged


def _intersect_descriptors(first: object, second: object) -> dict | None:
    if not isinstance(first, dict) or not isinstance(second, dict):
        return first if isinstance(first, dict) else None
    if first.get("type") != second.get("type"):
        return None
    kind = first.get("type")
    if kind == "enum":
        values = [v for v in first.get("values", []) if v in (second.get("values") or [])]
        return {"type": "enum", "values": values} if values else None
    if kind == "range":
        try:
            lo = max(int(first.get("min", 1)), int(second.get("min", 1)))
            hi = min(int(first.get("max", lo)), int(second.get("max", lo)))
        except (TypeError, ValueError):
            return None
        return {"type": "range", "min": lo, "max": hi} if hi >= lo else None
    return first


def _cap_values(caps: dict, name: str) -> list[str] | None:
    desc = caps.get(name)
    if isinstance(desc, dict) and desc.get("type") == "enum":
        values = desc.get("values")
        if isinstance(values, list) and values:
            return [str(v) for v in values]
    return None


def _cap_max(caps: dict, name: str) -> int | None:
    desc = caps.get(name)
    if isinstance(desc, dict) and desc.get("type") == "range":
        try:
            return max(1, int(desc.get("max", 1)))
        except (TypeError, ValueError):
            return None
    return None


def parse_ratio(text: str) -> float | None:
    try:
        left, right = (float(x) for x in text.replace(" ", "").split(":", 1))
    except ValueError:
        return None
    if left <= 0 or right <= 0:
        return None
    return left / right


def closest_ratio(requested: str, values: list[str]) -> str | None:
    if requested in values:
        return requested
    target = parse_ratio(requested)
    if target is None:
        return None
    best, best_diff = None, float("inf")
    for value in values:
        candidate = parse_ratio(value)
        if candidate is None:
            continue
        diff = abs(math.log(target / candidate))
        if diff < best_diff:
            best, best_diff = value, diff
    return best


def adapt_image_body(body: dict, caps: dict | None) -> tuple[dict, list[str]]:
    """Trim/adjust request fields to what the model supports. Returns (body, notes)."""
    notes: list[str] = []
    if not caps:
        return body, notes
    adapted = dict(body)
    values = _cap_values(caps, "resolution")
    if "resolution" not in caps or (values and adapted.get("resolution") not in values):
        adapted.pop("resolution", None)
    if "aspect_ratio" not in caps:
        adapted.pop("aspect_ratio", None)
    else:
        values = _cap_values(caps, "aspect_ratio")
        requested = adapted.get("aspect_ratio")
        if values and requested:
            closest = closest_ratio(str(requested), values)
            if closest:
                adapted["aspect_ratio"] = closest
            else:
                adapted.pop("aspect_ratio", None)
    if "output_format" not in caps:
        adapted.pop("output_format", None)
    else:
        values = _cap_values(caps, "output_format")
        if values and adapted.get("output_format") not in values:
            adapted["output_format"] = values[0]
    if "seed" not in caps:
        adapted.pop("seed", None)
    refs = adapted.get("input_references")
    if refs:
        if "input_references" not in caps:
            adapted.pop("input_references", None)
            notes.append("This model does not accept reference images; they were ignored.")
        else:
            max_refs = _cap_max(caps, "input_references")
            if max_refs and len(refs) > max_refs:
                adapted["input_references"] = refs[:max_refs]
                notes.append(f"This model accepts at most {max_refs} reference image(s); "
                             "the extra ones were ignored.")
    return adapted, notes


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

@dataclass
class GenerationRequest:
    prompt: str
    model: str
    aspect_ratio: str
    resolution: str
    output_format: str
    seed: int | None
    api_key: str
    layout: str = DEFAULT_LAYOUT
    uploads: list[Upload] = field(default_factory=list)


@dataclass
class GenerationResult:
    data: bytes
    mime: str
    ext: str
    width: int
    height: int
    cost: float
    seed: int | None
    elapsed: float
    notes: list[str] = field(default_factory=list)


def _first_image(payload: dict) -> bytes:
    items = payload.get("data") if isinstance(payload, dict) else None
    for item in items or []:
        if isinstance(item, dict) and item.get("b64_json"):
            b64 = str(item["b64_json"])
            if len(b64) > MAX_IMAGE_BYTES * 4 // 3 + 4:
                raise ProviderError("The generated image is too large.")
            try:
                raw = base64.b64decode(b64, validate=False)
            except (ValueError, TypeError) as exc:
                raise ProviderError("The provider returned an unreadable image.") from exc
            return raw
    raise ProviderError("The provider returned no image. Try another prompt or model.")


def generate(req: GenerationRequest, token: CancelToken, public_url: str = "") -> GenerationResult:
    """One OpenRouter image request (one retry only if the router rejects a parameter)."""
    start = time.perf_counter()
    caps = model_capabilities(req.model, req.api_key, token, public_url=public_url)
    token.check()
    final_prompt = build_final_prompt(req.prompt, context_text(req.uploads),
                                      req.aspect_ratio, req.resolution, caps, req.layout)
    base: dict = {
        "model": req.model,
        "prompt": final_prompt,
        "aspect_ratio": req.aspect_ratio,
        "resolution": req.resolution,
        "output_format": req.output_format,
    }
    refs = reference_images(req.uploads)
    if refs:
        base["input_references"] = refs
    if req.seed is not None:
        base["seed"] = req.seed
    headers = openrouter_headers(req.api_key, public_url)
    for attempt in (0, 1):
        body, notes = adapt_image_body(base, caps)
        status, raw = _http("POST", OPENROUTER_IMAGES_URL, headers, body, REQUEST_TIMEOUT_S, token)
        try:
            raise_for_status(status, raw, req.api_key, req.model)
        except ProviderError as exc:
            if attempt == 0 and is_capability_mismatch(exc):
                caps = model_capabilities(req.model, req.api_key, token, refresh=True,
                                          public_url=public_url)
                if caps:
                    continue
            raise
        try:
            payload = json.loads(raw)
        except ValueError as exc:
            raise ProviderError("The provider returned an invalid response.") from exc
        data = _first_image(payload)
        sniffed = sniff_image(data)
        if not sniffed:
            raise ProviderError("The provider returned a file that is not an image.")
        mime, width, height = sniffed
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        try:
            cost = float(usage.get("cost") or 0.0)
        except (TypeError, ValueError):
            cost = 0.0
        return GenerationResult(
            data=data, mime=mime, ext=EXTENSIONS[mime], width=width, height=height,
            cost=cost, seed=body.get("seed"), elapsed=time.perf_counter() - start, notes=notes)
    raise ProviderError("OpenRouter rejected the request.")  # pragma: no cover
