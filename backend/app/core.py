"""Image generation core: one provider request per generation (OpenRouter or OpenAI).

Trimmed for a public web app:
the visitor's own key, exactly one image per generation, uploads held in memory,
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
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field

OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images"
OPENROUTER_MODEL_ENDPOINTS_URL = "https://openrouter.ai/api/v1/images/models/{model}/endpoints"
OPENAI_GENERATIONS_URL = "https://api.openai.com/v1/images/generations"
OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits"
# Providers the visitor can pick (their own key). OpenRouter is the default.
PROVIDERS = {
    "openrouter": {"label": "OpenRouter", "default_model": "meta/muse-image"},
    "openai": {"label": "OpenAI", "default_model": "gpt-image-2.5-flare"},
}
DEFAULT_PROVIDER = "openrouter"
# the default provider's model (kept for /api/meta and older callers)
DEFAULT_MODEL = PROVIDERS[DEFAULT_PROVIDER]["default_model"]
APP_TITLE = "StoryGapBoard"

# Ratios for the whole image asked from the model (the app picks one per request, see the
# frontend's planGeneration): a wide set, so most panel shapes and grids fit well.
ASPECT_RATIOS = [
    "auto", "1:1", "1:2", "1:4", "1:8", "2:1", "2:3", "3:2", "3:4",
    "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9",
    "9:19.5", "19.5:9", "9:20", "20:9", "9:21", "21:9",
]
# The panel shapes the visitor picks from (the Ratio option): the well-known ones only.
PANEL_RATIOS = ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "4:5", "16:9", "9:16", "21:9"]
RESOLUTIONS = ["512", "1K", "2K", "4K"]
OUTPUT_FORMATS = ["png", "jpeg", "webp"]   # the visitor's download format (made in the browser)
# what the model is always asked for, when it supports the parameter: lossless input for the
# cutting, alignment and blending done in the browser
MODEL_OUTPUT_FORMAT = "png"
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
        raise ValueError("Add your API key in the Model section first.")
    if not API_KEY_RE.fullmatch(key):
        raise ValueError("The API key format is not valid.")
    return key


def validate_provider(raw: str | None) -> str:
    return validate_choice(raw or DEFAULT_PROVIDER, list(PROVIDERS), "provider")


def validate_model(raw: str | None, provider: str = DEFAULT_PROVIDER) -> str:
    model = (raw or "").strip() or PROVIDERS[provider]["default_model"]
    if not MODEL_RE.fullmatch(model):
        raise ValueError("The model name is not valid (example: meta/muse-image).")
    return model


def validate_prompt(raw: str | None, required: bool = True) -> str:
    prompt = (raw or "").strip()
    if not prompt and required:
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
        f"{rows} x {cols}). Panels are equal in size, fill the whole image edge to edge with no "
        "borders, gutters or margins between them, and read left to right, top to bottom. Each "
        "panel shows the next moment of the story below, keeping the same characters, style and "
        "setting across panels. Use the context and reference images, if any, for characters "
        "and style. No captions, speech bubbles or panel numbers unless the story asks for them."
    )


def _panel_list(numbers: list[int]) -> str:
    """[1] -> "Panel 1 is", [1, 4, 5] -> "Panels 1, 4 and 5 are"."""
    if len(numbers) == 1:
        return f"Panel {numbers[0]} is"
    head = ", ".join(str(n) for n in numbers[:-1])
    return f"Panels {head} and {numbers[-1]} are"


def validate_fixed_panels(raw: str | None, layout: str) -> list[int]:
    """Comma-separated 1-based panel numbers the visitor filled with their own images."""
    text = (raw or "").strip()
    if not text:
        return []
    rows, cols = parse_layout(layout)
    parts = [part.strip() for part in text.split(",")]
    if not all(part.isdigit() and len(part) <= 2 for part in parts):
        raise ValueError("Invalid fixed panels.")
    numbers = sorted({int(part) for part in parts})
    if numbers[0] < 1 or numbers[-1] > rows * cols:
        raise ValueError("Invalid fixed panels.")
    if len(numbers) == rows * cols:
        raise ValueError("Leave at least one panel empty for the model to draw.")
    return numbers


def fixed_panels_instruction(layout: str, fixed: list[int]) -> str:
    """Sent after the storyboard instruction when the first reference is the layout guide."""
    rows, cols = parse_layout(layout)
    empty = [n for n in range(1, rows * cols + 1) if n not in fixed]
    placeholders, them = (("a gray numbered placeholder", "it") if len(empty) == 1
                          else ("gray numbered placeholders", "them"))
    return (
        "The FIRST reference image is the layout guide of this storyboard: the same grid, panels "
        f"numbered 1 to {rows * cols} left to right, top to bottom. {_panel_list(fixed)} already "
        "finished: reproduce them exactly as they appear in the guide, in the same place. "
        f"{_panel_list(empty)} {placeholders}: draw {them} so the story flows through the finished "
        "panels, matching their characters, art style, colors and lighting. Never draw the gray "
        "placeholders or their numbers."
    )


MARK_COLORS = ["red", "green", "blue", "yellow"]


def edit_instruction(color: str = "red") -> str:
    """Fixed retouch instruction; names the color of the visitor's marks."""
    return (
        "You are editing ONE panel of a storyboard. Reference image 1 is the panel as it is now. "
        f"Reference image 2 is the same panel with {color} marks (painted strokes, circles or rectangles) showing "
        f"WHERE to edit: the {color} is only a pointer, never part of the picture. Make the change "
        "below inside the marked area, clearly and visibly: redraw that part completely if needed, "
        "and let it grow slightly past the marks when the change needs room (e.g. bigger hair). The "
        "result must look obviously different there, not just retouched. Keep everything away from "
        "the marks identical: same framing, camera, composition, characters, line work, art style, "
        f"colors and lighting. Return the whole panel at the same framing, with no {color} marks, "
        "borders or text."
    )


def validate_area(raw: str | None) -> tuple[int, int, int, int] | None:
    """Bounding box of the marks, "left,top,right,bottom" in % of the panel (optional)."""
    text = (raw or "").strip()
    if not text:
        return None
    parts = [part.strip() for part in text.split(",")]
    if len(parts) != 4 or not all(part.isdigit() and len(part) <= 3 for part in parts):
        raise ValueError("Invalid marked area.")
    left, top, right, bottom = (int(part) for part in parts)
    if right > 100 or bottom > 100 or left >= right or top >= bottom:
        raise ValueError("Invalid marked area.")
    return left, top, right, bottom


def _where(start: int, end: int, names: tuple[str, str, str]) -> str:
    middle = (start + end) / 2
    return names[0] if middle < 100 / 3 else names[2] if middle > 200 / 3 else names[1]


def area_hint(area: tuple[int, int, int, int]) -> str:
    """The marks' place in words, for models that look at the red marks less carefully."""
    left, top, right, bottom = area
    vertical = _where(top, bottom, ("top", "middle", "bottom"))
    horizontal = _where(left, right, ("left", "center", "right"))
    place = "center" if (vertical, horizontal) == ("middle", "center") else f"{vertical} {horizontal}"
    return (f"The marked area is in the {place} of the panel, spanning about {left}-{right}% of its "
            f"width (from the left) and {top}-{bottom}% of its height (from the top).")


def edit_aspect_ratio(width: int, height: int) -> str:
    """Closest supported ratio to the panel being edited."""
    ratio = closest_ratio(f"{width}:{height}", [r for r in ASPECT_RATIOS if r != "auto"])
    return ratio or "auto"


def _size_hints(prop: str, resolution: str, caps: dict | None) -> list[str]:
    """Size wishes as text, for models whose API does not carry those parameters."""
    hints = []
    if prop and prop != "auto" and (caps is None or "aspect_ratio" not in caps):
        hints.append(f"Generate the image with aspect ratio {prop}.")
    if resolution and (caps is None or "resolution" not in caps):
        hints.append(f"Generate the image at resolution tier {resolution}.")
    return hints


def story_block(base_prompt: str, has_fixed: bool) -> str:
    """The visitor's story, or (it is optional) the order to complete one."""
    if base_prompt.strip():
        return f"Story:\n{base_prompt.strip()}"
    if has_fixed:
        return ("Story: none given. Infer the story from the finished panels (and the context and "
                "reference images, if any) and complete it, so that all panels read as one coherent "
                "sequence.")
    return ("Story: none given. Make up a simple, coherent story with a beginning, a middle and an "
            "end, based on the context and reference images, if any.")


def build_final_prompt(base_prompt: str, context: str, prop: str, resolution: str,
                       caps: dict | None = None, layout: str = DEFAULT_LAYOUT,
                       fixed_panels: list[int] | None = None) -> str:
    """Storyboard instruction (+ fixed panels) + the visitor's story (optional), then context
    and the size hints (skipped when the API carries that parameter)."""
    chunks = [storyboard_instruction(layout)]
    if fixed_panels:
        chunks.append(fixed_panels_instruction(layout, fixed_panels))
    chunks.append(story_block(base_prompt, bool(fixed_panels)))
    if context:
        chunks.append(f"Context:\n{context}")
    chunks += _size_hints(prop, resolution, caps)
    return "\n\n".join(c for c in chunks if c)


def build_edit_prompt(instruction: str, prop: str, resolution: str,
                      caps: dict | None = None,
                      area: tuple[int, int, int, int] | None = None, color: str = "red") -> str:
    """Panel retouch: fixed edit instruction (+ where the marks are) + the visitor's change."""
    chunks = [edit_instruction(color)]
    if area:
        chunks.append(area_hint(area))
    chunks.append(f"Change:\n{instruction.strip()}")
    chunks += _size_hints(prop, resolution, caps)
    return "\n\n".join(chunks)


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


def _http(method: str, url: str, headers: dict, body: dict | bytes | None, timeout_s: int,
          token: CancelToken) -> tuple[int, str]:
    """Send one request (JSON from a dict, or raw bytes such as multipart) and return
    (status, text). Raises GenerationCancelled on cancel."""
    parts = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.hostname or "", parts.port, timeout=timeout_s)
    token.register(conn)
    try:
        token.check()
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        payload = body if isinstance(body, bytes) or body is None else json.dumps(body).encode("utf-8")
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


def raise_for_status(status: int, raw: str, api_key: str, model: str, provider: str = "OpenRouter") -> None:
    if status == 200:
        return
    detail = _provider_detail(raw, api_key)
    suffix = f" Provider says: {detail}" if detail else ""
    lowered = (raw or "").lower()
    if status in (401, 403) and "verif" in lowered:
        # OpenAI: GPT Image models need a verified organization
        raise ProviderError(f"{provider} needs your organization to be verified for this model.{suffix}", status)
    if status == 401:
        # a wrong or revoked key: counts towards the lock against key guessing
        raise ProviderAuthError(
            f"{provider} rejected the API key. Check it in the Model section.{suffix}", status)
    if status == 403:
        # a valid key without access (model, project or permission): not a guessed key, no lock
        raise ProviderError(
            f"{provider} accepted the key but refused this request: the key has no access to this model "
            f"or permission (check the model, or your project and organization settings).{suffix}", status)
    if status == 402 or "insufficient_quota" in lowered:
        raise ProviderError(f"Your {provider} account has no credits left for this request.", status)
    if status == 404:
        raise ProviderError(f"{provider} does not know the model {model!r}.{suffix}", status)
    if status == 429:
        raise ProviderError(f"{provider} is rate limiting your key. Wait a bit and try again.", status)
    if status == 400 and any(m in lowered for m in _CONTENT_POLICY_MARKERS):
        raise ContentPolicyError(
            "The provider's content filter blocked this request. Simplify the prompt, "
            "remove uploaded files, or try another model." + suffix, status)
    raise ProviderError(f"{provider} error (HTTP {status}).{suffix}", status)


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
            # PNG not on the model's list: let it use its own default (the browser converts anyway)
            adapted.pop("output_format", None)
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
    mode: str = "storyboard"   # "storyboard" | "edit" (uploads = [panel, marked panel])
    fixed_panels: list[int] = field(default_factory=list)
    guide: Upload | None = None
    area: tuple[int, int, int, int] | None = None   # edit: marks' box in % of the panel
    provider: str = DEFAULT_PROVIDER
    safety_id: str = ""                              # OpenAI: anonymised visitor id (salted hash)
    # what was sent to the provider (endpoint, final prompt, parameters; never the key), for the
    # development debug dump only
    sent: dict = field(default_factory=dict)
    mark_color: str = "red"                          # edit: color of the marks


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
    """One image request to the visitor's provider (OpenRouter: one retry only if the
    router rejects a parameter)."""
    if req.provider == "openai":
        return generate_openai(req, token)
    start = time.perf_counter()
    caps = model_capabilities(req.model, req.api_key, token, public_url=public_url)
    token.check()
    if req.mode == "edit":
        if caps and ("input_references" not in caps or (_cap_max(caps, "input_references") or 2) < 2):
            raise ProviderError("This model does not accept two input images, so it cannot edit "
                                "a panel. Pick a model with image input in Model.")
        final_prompt = build_edit_prompt(req.prompt, req.aspect_ratio, req.resolution, caps, req.area,
                                         req.mark_color)
    else:
        final_prompt = build_final_prompt(req.prompt, context_text(req.uploads),
                                          req.aspect_ratio, req.resolution, caps, req.layout,
                                          req.fixed_panels)
    base: dict = {
        "model": req.model,
        "prompt": final_prompt,
        "aspect_ratio": req.aspect_ratio,
        "resolution": req.resolution,
        # always lossless from the model: the browser cuts, blends and re-encodes the board in the
        # visitor's format (req.output_format) itself, so a JPEG/WebP here would only add artifacts
        "output_format": MODEL_OUTPUT_FORMAT,
    }
    # The layout guide goes first: it survives when a model caps the reference count.
    refs = reference_images(([req.guide] if req.guide else []) + req.uploads)
    if refs:
        base["input_references"] = refs
    if req.seed is not None:
        base["seed"] = req.seed
    headers = openrouter_headers(req.api_key, public_url)
    for attempt in (0, 1):
        body, notes = adapt_image_body(base, caps)
        req.sent = {"url": OPENROUTER_IMAGES_URL, "prompt": body["prompt"],
                    "params": {k: v for k, v in body.items() if k not in ("prompt", "input_references")},
                    "images": len(body.get("input_references") or [])}
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


# ---------------------------------------------------------------------------
# OpenAI (Image API): generations without input images, edits with them
# ---------------------------------------------------------------------------

# Pixel budget per size tier (GPT Image 2+ take any WxH: edges multiples of 16, at most
# 3840, long:short at most 3:1, 655,360 to 8,294,400 pixels in total).
OPENAI_TIER_PIXELS = {"512": 655_360, "1K": 1_048_576, "2K": 4_194_304, "4K": 8_294_400}
OPENAI_MIN_PIXELS = 655_360
OPENAI_MAX_PIXELS = 8_294_400
OPENAI_MAX_EDGE = 3840
OPENAI_LEGACY_SIZES = {"1024x1024": 1.0, "1536x1024": 1.5, "1024x1536": 2 / 3}
OPENAI_IMAGE_MIMES = ("image/png", "image/jpeg", "image/webp")


def _multiple_of_16(value: float) -> int:
    return max(16, int(value // 16) * 16)


def openai_size(aspect_ratio: str, resolution: str, model: str) -> tuple[str, str | None]:
    """OpenAI "size" for a ratio and size tier, plus a note when it had to be adjusted."""
    ratio = parse_ratio(aspect_ratio) if aspect_ratio != "auto" else None
    if ratio is None:
        return "auto", None
    if model.startswith("gpt-image-1"):
        # GPT Image 1.x: three fixed sizes only
        size = min(OPENAI_LEGACY_SIZES, key=lambda k: abs(math.log(ratio / OPENAI_LEGACY_SIZES[k])))
        note = None
        if abs(math.log(ratio / OPENAI_LEGACY_SIZES[size])) > 0.05:
            note = f"This model only makes 1024x1024, 1536x1024 or 1024x1536 images: {size} was used."
        return size, note
    note = None
    if ratio > 3 or ratio < 1 / 3:
        ratio = min(3.0, max(1 / 3, ratio))
        note = "OpenAI images are at most 3:1: the closest shape was used."
    pixels = OPENAI_TIER_PIXELS.get(resolution, OPENAI_TIER_PIXELS["1K"])
    long_ratio = max(ratio, 1 / ratio)   # long edge / short edge, at most 3

    def edges(short: int) -> tuple[int, int]:
        # the long edge is rounded down from the short one: it never passes 3:1
        long = _multiple_of_16(short * long_ratio)
        return (long, short) if ratio >= 1 else (short, long)

    short = _multiple_of_16(math.sqrt(pixels / long_ratio))
    w, h = edges(short)
    while w * h < OPENAI_MIN_PIXELS:   # rounding down may fall under the minimum
        short += 16
        w, h = edges(short)
    while w * h > OPENAI_MAX_PIXELS or max(w, h) > OPENAI_MAX_EDGE:
        short -= 16
        w, h = edges(short)
    return f"{w}x{h}", note


def _multipart(fields: list[tuple[str, str]], files: list[tuple[str, str, bytes, str]]) -> tuple[bytes, str]:
    """multipart/form-data body: text fields, then (field, filename, data, mime) files."""
    boundary = f"----StoryGapBoard{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields:
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
                      + value.encode("utf-8") + b"\r\n")
    for name, filename, data, mime in files:
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
                      f'filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + data + b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def generate_openai(req: GenerationRequest, token: CancelToken) -> GenerationResult:
    """One OpenAI Image API request: /images/generations (JSON) without input images,
    /images/edits (multipart, image[] repeated) with them (layout guide, references, retouch)."""
    start = time.perf_counter()
    notes: list[str] = []
    # size travels as a parameter, so no size hints in the prompt
    carried = {"aspect_ratio": {}, "resolution": {}}
    if req.mode == "edit":
        prompt = build_edit_prompt(req.prompt, req.aspect_ratio, req.resolution, carried, req.area, req.mark_color)
    else:
        prompt = build_final_prompt(req.prompt, context_text(req.uploads), req.aspect_ratio, req.resolution,
                                    carried, req.layout, req.fixed_panels)
    size, note = openai_size(req.aspect_ratio, req.resolution, req.model)
    if note:
        notes.append(note)
    if req.seed is not None:
        notes.append("OpenAI does not support seeds: it was ignored.")
    images = [u for u in ([req.guide] if req.guide else []) + req.uploads if u.kind == "image"]
    if any(u.mime not in OPENAI_IMAGE_MIMES for u in images):
        notes.append("OpenAI takes PNG, JPEG and WebP images: GIF references were not sent.")
        images = [u for u in images if u.mime in OPENAI_IMAGE_MIMES]
    if req.mode == "edit" and len(images) < 2:
        raise ProviderError("The panel to retouch could not be sent.")
    headers = {"Authorization": f"Bearer {req.api_key}", "Accept": "application/json"}
    # PNG asked explicitly (not left to OpenAI's default, which could change); see MODEL_OUTPUT_FORMAT
    params = [("model", req.model), ("prompt", prompt), ("size", size), ("output_format", MODEL_OUTPUT_FORMAT)]
    if req.safety_id:
        params.append(("safety_identifier", req.safety_id))
    req.sent = {"url": OPENAI_EDITS_URL if images else OPENAI_GENERATIONS_URL, "prompt": prompt,
                "params": {k: v for k, v in params if k != "prompt"}, "images": len(images)}
    if images:
        files = [("image[]", f"image{i}.{EXTENSIONS[u.mime]}", u.data, u.mime) for i, u in enumerate(images)]
        body, content_type = _multipart(params, files)
        headers["Content-Type"] = content_type
        status, raw = _http("POST", OPENAI_EDITS_URL, headers, body, REQUEST_TIMEOUT_S, token)
    else:
        headers["Content-Type"] = "application/json"
        status, raw = _http("POST", OPENAI_GENERATIONS_URL, headers, dict(params), REQUEST_TIMEOUT_S, token)
    raise_for_status(status, raw, req.api_key, req.model, provider="OpenAI")
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise ProviderError("The provider returned an invalid response.") from exc
    data = _first_image(payload)
    sniffed = sniff_image(data)
    if not sniffed:
        raise ProviderError("The provider returned a file that is not an image.")
    mime, width, height = sniffed
    # OpenAI reports tokens, not a price: the cost stays unknown (0) here
    return GenerationResult(data=data, mime=mime, ext=EXTENSIONS[mime], width=width, height=height,
                            cost=0.0, seed=None, elapsed=time.perf_counter() - start, notes=notes)
