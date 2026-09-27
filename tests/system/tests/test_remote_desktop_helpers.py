"""Unit tests for the remote-desktop canvas helpers (no app needed).

``test_vnc.py`` locates each quadrant of the fixtures' test pattern on the canvas
through :func:`framebuffer_to_canvas`, which mirrors ``RemoteDesktopCanvas``'s
draw geometry. A geometry slip there would make the live suite sample the wrong
pixels (a false failure, or worse a false pass on a letterbox bar), so the math
is pinned here where it runs on every PR.
"""

from __future__ import annotations

import pytest

from termihub_harness import VNC_FB_HEIGHT, VNC_FB_WIDTH, VNC_QUADRANT_COLORS
from termihub_harness.ui.remote_desktop import (
    color_matches,
    framebuffer_to_canvas,
    quadrant_probe_points,
)

FB = (VNC_FB_WIDTH, VNC_FB_HEIGHT)


def test_fit_letterboxes_a_wider_canvas_horizontally():
    # 1024x768 into 1600x600: scale 600/768, drawn 800 wide, centred at x=400.
    canvas = (1600, 600)
    assert framebuffer_to_canvas((0, 0), FB, canvas, "fit") == (400, 0)
    assert framebuffer_to_canvas((512, 384), FB, canvas, "fit") == (800, 300)
    # The far corner lands just past the drawn area, clamped only vertically.
    assert framebuffer_to_canvas((1024, 768), FB, canvas, "fit") == (1200, 599)


def test_fit_letterboxes_a_taller_canvas_vertically():
    # 1024x768 into 512x1000: scale 0.5, drawn 384 tall, centred at y=308.
    canvas = (512, 1000)
    assert framebuffer_to_canvas((0, 0), FB, canvas, "fit") == (0, 308)
    assert framebuffer_to_canvas((256, 192), FB, canvas, "fit") == (128, 404)


def test_match_stretches_each_axis_independently():
    canvas = (2048, 384)
    assert framebuffer_to_canvas((512, 384), FB, canvas, "match") == (1024, 192)


def test_pixel_mode_is_one_to_one_and_clamped():
    canvas = (800, 600)
    assert framebuffer_to_canvas((100, 50), FB, canvas, "pixel") == (100, 50)
    # A point the 1:1 canvas cannot show is clamped onto its edge.
    assert framebuffer_to_canvas((1000, 700), FB, canvas, "pixel") == (799, 599)


def test_probe_points_stay_inside_their_quadrant():
    probes = quadrant_probe_points(*FB)
    assert set(probes) == set(VNC_QUADRANT_COLORS)
    half_w, half_h = FB[0] / 2, FB[1] / 2
    for name, points in probes.items():
        right = name.endswith("right")
        bottom = name.startswith("bottom")
        for x, y in points:
            assert (x >= half_w) == right, (name, x)
            assert (y >= half_h) == bottom, (name, y)
            # Well clear of the quadrant edges (and the centre cursor marker).
            assert min(x % half_w, half_w - x % half_w) >= half_w * 0.2
            assert min(y % half_h, half_h - y % half_h) >= half_h * 0.2


@pytest.mark.parametrize(
    ("rgba", "expected", "matches"),
    [
        ([255, 0, 0, 255], (255, 0, 0), True),
        ([250, 6, 3, 255], (255, 0, 0), True),
        ([0, 0, 0, 255], (255, 0, 0), False),
        ([255, 0, 0, 0], (255, 0, 0), False),  # transparent = nothing painted
        ([0, 0, 255, 255], (255, 0, 0), False),  # swapped channels
    ],
)
def test_color_matches(rgba, expected, matches):
    assert color_matches(rgba, expected) is matches
