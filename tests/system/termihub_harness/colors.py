"""Colour maths for grading the rendered theme from computed styles (#4930).

The bridge returns colours as the WebView computes them: ``rgb(…)`` /
``rgba(…)`` for resolved properties, ``color(srgb r g b / a)`` from newer
WebKit, or the authored ``#rrggbb`` / ``rgba(…)`` text of a CSS custom property
read off ``:root``. This module parses all of those and implements the WCAG 2.x
relative luminance and contrast ratio, mirroring ``src/themes/contrast.ts`` so a
system test grades a colour pair exactly as the theme engine's own unit tests do.

A translucent colour (a scrollbar thumb is ``rgba(…, 0.5)``) has no contrast of
its own: :func:`composite` lays it over the surface it is painted on first, and
:func:`contrast` does that for you when given the background.

Pure functions, unit-tested in the normal lane (``tests/test_colors.py``).
"""

from __future__ import annotations

import re
from typing import NamedTuple, Optional


class Rgba(NamedTuple):
    """An sRGB colour with 0-255 channels and a 0-1 alpha."""

    r: float
    g: float
    b: float
    a: float = 1.0

    @property
    def opaque(self) -> bool:
        return self.a >= 0.999

    def hex(self) -> str:
        """``#rrggbb`` of the colour channels (alpha dropped)."""
        return "#" + "".join(f"{round(c):02x}" for c in (self.r, self.g, self.b))


_HEX = re.compile(r"^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$", re.IGNORECASE)
_FUNC = re.compile(r"^(rgba?|color)\((.*)\)$", re.IGNORECASE | re.DOTALL)

#: CSS keywords that mean "no paint" (an unset custom property reads as "").
_TRANSPARENT = {"transparent", "", "none", "rgba(0, 0, 0, 0)"}


def _channel(token: str) -> float:
    token = token.strip()
    if token.endswith("%"):
        return float(token[:-1]) * 255.0 / 100.0
    return float(token)


def _alpha(token: str) -> float:
    token = token.strip()
    if token.endswith("%"):
        return float(token[:-1]) / 100.0
    return float(token)


def parse_color(value: str) -> Rgba:
    """Parse a computed or authored CSS colour into :class:`Rgba`.

    Accepts ``#rgb``/``#rgba``/``#rrggbb``/``#rrggbbaa``, ``rgb()``/``rgba()`` in
    comma or space syntax (with an optional ``/ alpha``), ``color(srgb r g b
    [/ a])`` with 0-1 channels, and ``transparent``. Raises ``ValueError`` on
    anything else, so a grade never silently compares an unparsed string.
    """
    text = (value or "").strip()
    if text.lower() in _TRANSPARENT:
        return Rgba(0, 0, 0, 0.0)
    m = _HEX.match(text)
    if m:
        digits = m.group(1)
        if len(digits) in (3, 4):
            digits = "".join(c + c for c in digits)
        r, g, b = (int(digits[i : i + 2], 16) for i in (0, 2, 4))
        a = int(digits[6:8], 16) / 255.0 if len(digits) == 8 else 1.0
        return Rgba(r, g, b, a)
    m = _FUNC.match(text)
    if not m:
        raise ValueError(f"not a CSS colour: {value!r}")
    kind, body = m.group(1).lower(), m.group(2).strip()
    alpha = 1.0
    if "/" in body:
        body, alpha_text = body.rsplit("/", 1)
        alpha = _alpha(alpha_text)
    parts = [p for p in re.split(r"[\s,]+", body.strip()) if p]
    if kind == "color":
        if not parts or parts[0].lower() not in ("srgb", "srgb-linear"):
            raise ValueError(f"unsupported colour space: {value!r}")
        if parts[0].lower() != "srgb":
            raise ValueError(f"unsupported colour space: {value!r}")
        r, g, b = (float(p) * 255.0 for p in parts[1:4])
        return Rgba(r, g, b, alpha)
    if len(parts) == 4:
        alpha = _alpha(parts[3])
        parts = parts[:3]
    if len(parts) != 3:
        raise ValueError(f"not a CSS colour: {value!r}")
    r, g, b = (_channel(p) for p in parts)
    return Rgba(r, g, b, alpha)


def composite(fg: Rgba | str, bg: Rgba | str) -> Rgba:
    """``fg`` painted over ``bg`` (source-over), as an opaque colour.

    ``bg`` must itself be opaque — a translucent backdrop has no defined colour
    until it is laid over something, so that is a caller error.
    """
    top = parse_color(fg) if isinstance(fg, str) else fg
    base = parse_color(bg) if isinstance(bg, str) else bg
    if not base.opaque:
        raise ValueError(f"backdrop must be opaque to composite onto: {base}")
    a = top.a
    return Rgba(
        top.r * a + base.r * (1 - a),
        top.g * a + base.g * (1 - a),
        top.b * a + base.b * (1 - a),
        1.0,
    )


def relative_luminance(color: Rgba | str) -> float:
    """WCAG 2.x relative luminance (0 black … 1 white) of an opaque colour."""
    c = parse_color(color) if isinstance(color, str) else color
    if not c.opaque:
        raise ValueError(f"luminance of a translucent colour is undefined: {c}")

    def lin(channel: float) -> float:
        s = channel / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)


def contrast(fg: Rgba | str, bg: Rgba | str, *, backdrop: Optional[Rgba | str] = None) -> float:
    """WCAG contrast ratio (1 … 21) of ``fg`` against ``bg``.

    A translucent ``fg`` is composited onto ``bg`` first (a thumb over its
    track). A translucent ``bg`` needs ``backdrop`` — the opaque surface under
    it — and is composited onto that before ``fg`` is.
    """
    base = parse_color(bg) if isinstance(bg, str) else bg
    if not base.opaque:
        if backdrop is None:
            raise ValueError(f"translucent background {base} needs a backdrop")
        base = composite(base, backdrop)
    top = parse_color(fg) if isinstance(fg, str) else fg
    if not top.opaque:
        top = composite(top, base)
    hi, lo = sorted((relative_luminance(top), relative_luminance(base)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def is_light(color: Rgba | str, *, backdrop: Optional[Rgba | str] = None) -> bool:
    """Whether a surface reads as light: closer to white than to black.

    Uses the WCAG crossover (luminance ≈ 0.179, where black and white text have
    equal contrast) so "light" means "dark text is the readable choice".
    """
    c = parse_color(color) if isinstance(color, str) else color
    if not c.opaque:
        if backdrop is None:
            raise ValueError(f"translucent colour {c} needs a backdrop")
        c = composite(c, backdrop)
    return relative_luminance(c) > 0.179


def same_color(a: Rgba | str, b: Rgba | str, *, tolerance: float = 1.5) -> bool:
    """Whether two colours match per channel within ``tolerance`` (0-255 scale).

    Alpha must match within 0.02. The tolerance absorbs the rounding a WebView
    applies when it resolves ``#rrggbb`` to ``rgb()`` or to ``color(srgb …)``.
    """
    ca = parse_color(a) if isinstance(a, str) else a
    cb = parse_color(b) if isinstance(b, str) else b
    return (
        all(abs(x - y) <= tolerance for x, y in zip(ca[:3], cb[:3]))
        and abs(ca.a - cb.a) <= 0.02
    )


def px(value: str) -> float:
    """``"12.5px"`` → ``12.5``; raises ``ValueError`` on a non-pixel value."""
    text = (value or "").strip()
    if not text.endswith("px"):
        raise ValueError(f"not a pixel length: {value!r}")
    return float(text[:-2])
