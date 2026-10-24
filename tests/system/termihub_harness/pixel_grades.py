"""Pixel grades over a native window capture (#4937).

Given a :class:`~termihub_harness.window_capture.Frame` of the app's window and
the device-pixel rects of terminal cells, these answer the questions an
operator used to answer by eye:

- :func:`cell_fill` / :func:`dominant_color` — what colour a cell's
  background paints (the most common colour in its inner area);
- :func:`ink_count` / :func:`has_color` — whether a glyph painted anything,
  and in the colour it should;
- :func:`horizontal_line` / :func:`vertical_line` — whether a box-drawing
  stroke runs unbroken across cell boundaries;
- :func:`glyph_mask` / :func:`mask_distance` — a glyph's ink shape, to tell
  a real Nerd Font glyph from the "tofu" box a missing glyph falls back to;
- :func:`near_white_fraction` — how much of a frame is near-white (the
  startup white-flash detector).

Colours are ``(r, g, b)`` tuples of 0-255 ints. Pure functions, unit-tested
in the normal lane (``tests/test_pixel_grades.py``).
"""

from __future__ import annotations

from collections import Counter
from typing import NamedTuple, Optional, Sequence

from .window_capture import Frame, Rect

RGB = tuple[int, int, int]

#: Default per-channel tolerance for "the same colour": absorbs a display
#: colour profile, sub-pixel blending at a cell's edge and JPEG-free but
#: gamma-adjusted capture paths, while still telling ANSI colours apart.
COLOR_TOLERANCE = 28


def hex_rgb(value: str) -> RGB:
    """``#rrggbb`` → ``(r, g, b)``."""
    text = value.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(c + c for c in text)
    if len(text) < 6:
        raise ValueError(f"not a #rrggbb colour: {value!r}")
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)


def distance(a: Sequence[int], b: Sequence[int]) -> int:
    """The largest per-channel difference between two colours."""
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]))


def close(a: Sequence[int], b: Sequence[int], tolerance: int = COLOR_TOLERANCE) -> bool:
    return distance(a, b) <= tolerance


def inset(rect: Rect, fraction: float = 0.2) -> Rect:
    """``rect`` shrunk by ``fraction`` of its size on every side (at least 1 px)."""
    dx = max(1, int(rect.w * fraction)) if rect.w > 2 else 0
    dy = max(1, int(rect.h * fraction)) if rect.h > 2 else 0
    return Rect(rect.x + dx, rect.y + dy, max(1, rect.w - 2 * dx), max(1, rect.h - 2 * dy))


def dominant_color(frame: Frame, rect: Rect, *, quantize: int = 4) -> RGB:
    """The most common colour in ``rect`` (channels bucketed by ``quantize``)."""
    counts: Counter[RGB] = Counter()
    sums: dict[RGB, list[int]] = {}
    for p in frame.pixels(rect):
        key = (p[0] // quantize, p[1] // quantize, p[2] // quantize)
        counts[key] += 1
        acc = sums.setdefault(key, [0, 0, 0])
        acc[0] += p[0]
        acc[1] += p[1]
        acc[2] += p[2]
    if not counts:
        raise ValueError(f"rect {rect} has no pixels in the frame")
    key, n = counts.most_common(1)[0]
    acc = sums[key]
    return round(acc[0] / n), round(acc[1] / n), round(acc[2] / n)


def cell_fill(frame: Frame, rect: Rect) -> RGB:
    """The background colour a cell paints: the dominant colour of its inner area."""
    return dominant_color(frame, inset(rect))


def ink_count(
    frame: Frame, rect: Rect, background: Sequence[int], tolerance: int = COLOR_TOLERANCE
) -> int:
    """How many pixels in ``rect`` differ from ``background`` (the glyph's ink)."""
    return sum(1 for p in frame.pixels(rect) if distance(p, background) > tolerance)


def has_color(
    frame: Frame,
    rect: Rect,
    color: Sequence[int],
    *,
    tolerance: int = COLOR_TOLERANCE,
    min_pixels: int = 1,
) -> bool:
    """Whether at least ``min_pixels`` pixels in ``rect`` match ``color``."""
    n = 0
    for p in frame.pixels(rect):
        if distance(p, color) <= tolerance:
            n += 1
            if n >= min_pixels:
                return True
    return False


def closest(color: Sequence[int], palette: dict[str, Sequence[int]]) -> str:
    """The name of the ``palette`` entry nearest to ``color``."""
    return min(palette, key=lambda name: distance(color, palette[name]))


def _is_ink(frame: Frame, x: int, y: int, background: Sequence[int], tolerance: int) -> bool:
    return distance(frame.pixel(x, y), background) > tolerance


def horizontal_line(
    frame: Frame, rect: Rect, background: Sequence[int], tolerance: int = COLOR_TOLERANCE
) -> Optional[int]:
    """The first pixel row in ``rect`` that is ink from its left to its right edge.

    ``None`` when every row has a gap — a box-drawing stroke broken between
    cells. ``rect`` is clipped to the frame.
    """
    r = frame.clip(rect)
    for y in range(r.y, r.bottom):
        if all(_is_ink(frame, x, y, background, tolerance) for x in range(r.x, r.right)):
            return y
    return None


def vertical_line(
    frame: Frame, rect: Rect, background: Sequence[int], tolerance: int = COLOR_TOLERANCE
) -> Optional[int]:
    """The first pixel column in ``rect`` that is ink from its top to its bottom edge."""
    r = frame.clip(rect)
    for x in range(r.x, r.right):
        if all(_is_ink(frame, x, y, background, tolerance) for y in range(r.y, r.bottom)):
            return x
    return None


class GlyphMask(NamedTuple):
    """A glyph's ink as a ``w`` x ``h`` grid of booleans (row-major)."""

    w: int
    h: int
    bits: tuple[bool, ...]

    @property
    def ink(self) -> int:
        return sum(self.bits)


def glyph_mask(
    frame: Frame, rect: Rect, background: Sequence[int], tolerance: int = COLOR_TOLERANCE
) -> GlyphMask:
    """The ink shape of the glyph painted in ``rect``."""
    r = frame.clip(rect)
    bits = tuple(
        distance(frame.pixel(x, y), background) > tolerance
        for y in range(r.y, r.bottom)
        for x in range(r.x, r.right)
    )
    return GlyphMask(r.w, r.h, bits)


def mask_difference(a: GlyphMask, b: GlyphMask) -> float:
    """The fraction of pixels whose ink differs between two same-size masks.

    0.0 for identical shapes; masks of different sizes are compared over
    their common top-left area.
    """
    w, h = min(a.w, b.w), min(a.h, b.h)
    if w == 0 or h == 0:
        return 1.0
    differ = sum(
        1 for y in range(h) for x in range(w) if a.bits[y * a.w + x] != b.bits[y * b.w + x]
    )
    return differ / (w * h)


def _shifted_difference(a: GlyphMask, b: GlyphMask, dx: int, dy: int) -> float:
    """:func:`mask_difference` with ``b`` moved by ``(dx, dy)`` over ``a``."""
    w, h = min(a.w, b.w), min(a.h, b.h)
    differ = total = 0
    for y in range(h):
        by = y + dy
        if not 0 <= by < b.h:
            continue
        for x in range(w):
            bx = x + dx
            if not 0 <= bx < b.w:
                continue
            total += 1
            differ += a.bits[y * a.w + x] != b.bits[by * b.w + bx]
    return differ / total if total else 1.0


def mask_distance(a: GlyphMask, b: GlyphMask, shift: int = 2) -> float:
    """The smallest :func:`mask_difference` with ``b`` shifted up to ``shift`` px.

    Cell rects land on fractional pixel positions (the DOM renderer's cell
    width is not a whole number), so the same glyph can sit a pixel apart in
    two cells; this compares shapes, not positions.
    """
    if min(a.w, a.h, b.w, b.h) == 0:
        return 1.0
    return min(
        _shifted_difference(a, b, dx, dy)
        for dx in range(-shift, shift + 1)
        for dy in range(-shift, shift + 1)
    )


def near_white_fraction(frame: Frame, *, threshold: int = 225, step: int = 4) -> float:
    """The fraction of (sampled) pixels whose every channel is at least ``threshold``."""
    total = white = 0
    for p in frame.pixels(step=step):
        total += 1
        if p[0] >= threshold and p[1] >= threshold and p[2] >= threshold:
            white += 1
    return white / total if total else 0.0
