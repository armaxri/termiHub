"""Unit tests for the pixel grades over a native capture (#4937).

Synthetic frames stand in for the app window: a painted cell, a box-drawing
stroke with and without a gap, a glyph against a tofu box, a white frame.
"""

from __future__ import annotations

import pytest

from termihub_harness.pixel_grades import (
    cell_fill,
    closest,
    distance,
    dominant_color,
    glyph_mask,
    has_color,
    hex_rgb,
    horizontal_line,
    ink_count,
    inset,
    mask_difference,
    near_white_fraction,
    vertical_line,
)
from termihub_harness.window_capture import Frame, Rect

BG = (15, 17, 23)
FG = (221, 225, 236)


def _canvas(width: int, height: int, ink: set[tuple[int, int]], color=FG) -> Frame:
    buf = bytearray(bytes(BG) * (width * height))
    for x, y in ink:
        i = (y * width + x) * 3
        buf[i : i + 3] = bytes(color)
    return Frame(width, height, bytes(buf))


def test_hex_and_distance():
    assert hex_rgb("#0f1117") == BG
    assert hex_rgb("fff") == (255, 255, 255)
    with pytest.raises(ValueError):
        hex_rgb("#12")
    assert distance((0, 0, 0), (3, 9, 1)) == 9


def test_inset_keeps_at_least_one_pixel():
    assert inset(Rect(0, 0, 10, 20)) == Rect(2, 4, 6, 12)
    assert inset(Rect(5, 5, 2, 2)) == Rect(5, 5, 2, 2)


def test_cell_fill_ignores_antialiased_edges_and_a_glyph():
    # A red cell with a dark 1-px edge and a few glyph pixels inside.
    w, h = 10, 20
    ink = {(x, y) for x in range(w) for y in range(h) if x in (0, w - 1) or y in (0, h - 1)}
    frame = _canvas(w, h, set(), color=(200, 0, 0))
    buf = bytearray(bytes((200, 0, 0)) * (w * h))
    for x, y in ink | {(4, 9), (5, 9)}:
        i = (y * w + x) * 3
        buf[i : i + 3] = bytes(BG)
    frame = Frame(w, h, bytes(buf))
    assert cell_fill(frame, Rect(0, 0, w, h)) == (200, 0, 0)
    assert dominant_color(frame, Rect(0, 0, w, h)) == (200, 0, 0)


def test_ink_count_and_has_color():
    frame = _canvas(4, 4, {(1, 1), (2, 2)})
    assert ink_count(frame, Rect(0, 0, 4, 4), BG) == 2
    assert has_color(frame, Rect(0, 0, 4, 4), FG)
    assert not has_color(frame, Rect(0, 0, 4, 4), FG, min_pixels=3)
    assert not has_color(frame, Rect(0, 0, 1, 1), FG)


def test_closest_picks_the_nearest_palette_entry():
    palette = {"red": (205, 49, 49), "green": (13, 188, 121), "bg": BG}
    assert closest((200, 50, 40), palette) == "red"
    assert closest((20, 20, 20), palette) == "bg"


def test_horizontal_line_finds_an_unbroken_row_and_rejects_a_gap():
    w = 30
    solid = _canvas(w, 10, {(x, 5) for x in range(w)})
    assert horizontal_line(solid, Rect(0, 0, w, 10), BG) == 5
    gap = _canvas(w, 10, {(x, 5) for x in range(w) if x != 10})
    assert horizontal_line(gap, Rect(0, 0, w, 10), BG) is None


def test_vertical_line_finds_an_unbroken_column_and_rejects_a_gap():
    h = 40
    solid = _canvas(10, h, {(4, y) for y in range(h)})
    assert vertical_line(solid, Rect(0, 0, 10, h), BG) == 4
    gap = _canvas(10, h, {(4, y) for y in range(h) if y != 20})
    assert vertical_line(gap, Rect(0, 0, 10, h), BG) is None


def test_glyph_mask_tells_a_glyph_from_a_tofu_box():
    w, h = 8, 12
    tofu = {(x, y) for x in range(1, w - 1) for y in range(1, h - 1) if x in (1, w - 2) or y in (1, h - 2)}
    triangle = {(x, y) for y in range(h) for x in range(w) if x <= min(y, h - 1 - y) * w // h * 2}
    a = glyph_mask(_canvas(w, h, tofu), Rect(0, 0, w, h), BG)
    b = glyph_mask(_canvas(w, h, triangle), Rect(0, 0, w, h), BG)
    same = glyph_mask(_canvas(w, h, tofu), Rect(0, 0, w, h), BG)
    assert a.ink == len(tofu)
    assert mask_difference(a, same) == 0.0
    assert mask_difference(a, b) > 0.25
    assert mask_difference(a, glyph_mask(_canvas(1, 1, set()), Rect(0, 0, 0, 0), BG)) == 1.0


def test_near_white_fraction():
    white = Frame.filled(8, 8, (250, 250, 250))
    dark = Frame.filled(8, 8, BG)
    assert near_white_fraction(white, step=1) == 1.0
    assert near_white_fraction(dark, step=1) == 0.0
    half = Frame(2, 1, bytes((255, 255, 255)) + bytes(BG))
    assert near_white_fraction(half, step=1) == 0.5
