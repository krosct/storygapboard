"""Development only: a simulated image model, so the whole flow can be tried for free.

On when DEBUG_FAKE_MODEL is set (1/true/yes) and PUBLIC_URL is not (devkit sets it on
the server, so production always calls the real provider). No provider is called:
a generation gets a checkerboard per panel with the panel number (to see the cut and
move the framing), a retouch gets a loud checkerboard, so the blended area stands out.
Images are plain PNGs written by hand (no Pillow, like the rest of the backend).
"""

from __future__ import annotations

import struct
import time
import zlib

from . import core

LONG_SIDE = 1024
DELAY_S = 0.8   # long enough to see the progress, short enough to iterate

# 5x7 digits for the panel numbers ("#" = ink)
DIGITS = {
    "0": ("###", "#.#", "#.#", "#.#", "###"), "1": (".#.", "##.", ".#.", ".#.", "###"),
    "2": ("###", "..#", "###", "#..", "###"), "3": ("###", "..#", "###", "..#", "###"),
    "4": ("#.#", "#.#", "###", "..#", "..#"), "5": ("###", "#..", "###", "..#", "###"),
    "6": ("###", "#..", "###", "#.#", "###"), "7": ("###", "..#", "..#", "..#", "..#"),
    "8": ("###", "#.#", "###", "#.#", "###"), "9": ("###", "#.#", "###", "..#", "###"),
}
PANEL_COLORS = [
    ((91, 125, 177), (70, 100, 150)), ((177, 91, 91), (150, 70, 70)), ((91, 177, 125), (70, 150, 100)),
    ((177, 163, 91), (150, 138, 70)), ((138, 91, 177), (115, 70, 150)), ((91, 170, 177), (70, 145, 150)),
]
RETOUCH_COLORS = ((255, 0, 170), (255, 220, 0))


class Canvas:
    def __init__(self, width: int, height: int) -> None:
        self.width, self.height = width, height
        self.pixels = bytearray(width * height * 3)

    def fill(self, x: int, y: int, w: int, h: int, rgb: tuple[int, int, int]) -> None:
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(self.width, x + w), min(self.height, y + h)
        if x1 <= x0 or y1 <= y0:
            return
        row = bytes(rgb) * (x1 - x0)
        for yy in range(y0, y1):
            start = (yy * self.width + x0) * 3
            self.pixels[start:start + len(row)] = row

    def checker(self, x: int, y: int, w: int, h: int, size: int, a: tuple, b: tuple) -> None:
        for cy in range(0, h, size):
            for cx in range(0, w, size):
                color = a if (cx // size + cy // size) % 2 == 0 else b
                self.fill(x + cx, y + cy, min(size, w - cx), min(size, h - cy), color)

    def number(self, text: str, cx: int, cy: int, scale: int, rgb: tuple) -> None:
        width = len(text) * 4 * scale - scale
        x = cx - width // 2
        for ch in text:
            for row, line in enumerate(DIGITS[ch]):
                for col, mark in enumerate(line):
                    if mark == "#":
                        self.fill(x + col * scale, cy - 5 * scale // 2 + row * scale, scale, scale, rgb)
            x += 4 * scale

    def png(self) -> bytes:
        def chunk(tag: bytes, data: bytes) -> bytes:
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        stride = self.width * 3
        raw = b"".join(b"\x00" + bytes(self.pixels[y * stride:(y + 1) * stride]) for y in range(self.height))
        ihdr = struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6))
                + chunk(b"IEND", b""))


def _size(aspect_ratio: str) -> tuple[int, int]:
    ratio = core.parse_ratio(aspect_ratio) if aspect_ratio != "auto" else None
    ratio = ratio or 1.0
    if ratio >= 1:
        return LONG_SIDE, max(16, round(LONG_SIDE / ratio))
    return max(16, round(LONG_SIDE * ratio)), LONG_SIDE


def _wait(token: core.CancelToken) -> None:
    waited = 0.0
    while waited < DELAY_S:
        token.check()
        time.sleep(0.05)
        waited += 0.05
    token.check()


def generate(req: core.GenerationRequest, token: core.CancelToken) -> core.GenerationResult:
    """Same contract as core.generate, without any provider."""
    start = time.perf_counter()
    if req.mode == "edit":
        prompt = core.build_edit_prompt(req.prompt, req.aspect_ratio, req.resolution, None, req.area, req.mark_color)
    else:
        prompt = core.build_final_prompt(req.prompt, core.context_text(req.uploads), req.aspect_ratio,
                                         req.resolution, None, req.layout, req.fixed_panels)
    req.sent = {"url": "fake-model://local", "prompt": prompt, "params": {"aspect_ratio": req.aspect_ratio},
                "images": len([u for u in ([req.guide] if req.guide else []) + req.uploads if u.kind == "image"])}
    _wait(token)
    width, height = _size(req.aspect_ratio)
    image = Canvas(width, height)
    if req.mode == "edit":
        image.checker(0, 0, width, height, max(8, width // 16), *RETOUCH_COLORS)
    else:
        rows, cols = core.parse_layout(req.layout)
        for i in range(rows * cols):
            r, c = divmod(i, cols)
            x0, x1 = c * width // cols, (c + 1) * width // cols
            y0, y1 = r * height // rows, (r + 1) * height // rows
            a, b = PANEL_COLORS[i % len(PANEL_COLORS)]
            image.checker(x0, y0, x1 - x0, y1 - y0, max(8, min(x1 - x0, y1 - y0) // 8), a, b)
            scale = max(2, min(x1 - x0, y1 - y0) // 14)
            image.number(str(i + 1), (x0 + x1) // 2, (y0 + y1) // 2, scale, (255, 255, 255))
    data = image.png()
    return core.GenerationResult(
        data=data, mime="image/png", ext="png", width=width, height=height, cost=0.0, seed=None,
        elapsed=time.perf_counter() - start, notes=["Fake model (development): no provider was called."])
