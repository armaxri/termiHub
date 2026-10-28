"""Unit tests for the OS file-drop helpers (#4936) — no app, no display.

Covers the synthetic Tauri drag-drop payloads (physical coordinates, event
order), the XDND partner plumbing (argv, URI decoding, free screen space) and
the native drag gesture's safety: every move goes through the PID-checked
:class:`~termihub_harness.os_input.OsInput`, and the button is always released.
"""

from __future__ import annotations

import sys
from typing import Optional

import pytest

from termihub_harness.os_input import GlobalInjectionRefused, OsInput, OsInputUnavailable, OsWindow
from termihub_harness.os_input import xdnd
from termihub_harness.os_input.linux import on_screen
from termihub_harness.os_input.xdnd import (
    free_region,
    native_drag,
    partner_command,
    partner_env,
    uri_paths,
)
from termihub_harness.ui.os_drop import (
    DRAG_DROP,
    DRAG_ENTER,
    DRAG_OVER,
    EXPECT_DPR_ENV,
    check_device_pixel_ratio,
    drop_payloads,
    physical_point,
)

CI = {"GITHUB_ACTIONS": "true"}


# ── Synthetic Tauri drag-drop events ─────────────────────────────────────────
def test_physical_point_scales_the_css_point_by_device_pixel_ratio_on_windows():
    probe = {"rect": {"left": 10, "top": 20, "width": 100, "height": 50}, "devicePixelRatio": 2}
    assert physical_point(probe, platform="win32") == {"x": 120.0, "y": 90.0}
    assert physical_point(probe, 0.0, 1.0, platform="win32") == {"x": 20.0, "y": 140.0}


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_physical_point_stays_in_css_pixels_on_linux_and_macos(platform):
    """#4997: GTK and AppKit report logical drop coordinates at any scale."""
    probe = {"rect": {"left": 10, "top": 20, "width": 100, "height": 50}, "devicePixelRatio": 2}
    assert physical_point(probe, platform=platform) == {"x": 60.0, "y": 45.0}


def test_physical_point_defaults_to_scale_one():
    probe = {"rect": {"left": 0, "top": 0, "width": 10, "height": 10}}
    assert physical_point(probe) == {"x": 5.0, "y": 5.0}


@pytest.mark.parametrize("rect", [None, {"left": 0, "top": 0, "width": 0, "height": 5}])
def test_physical_point_refuses_an_unlaid_element(rect):
    with pytest.raises(AssertionError, match="no laid-out box"):
        physical_point({"rect": rect, "devicePixelRatio": 1})


def test_drop_payloads_are_enter_over_drop_with_string_paths(tmp_path):
    position = {"x": 1.0, "y": 2.0}
    events = drop_payloads([tmp_path / "a b.txt", "/c"], position)
    names = [str(tmp_path / "a b.txt"), "/c"]
    assert events == [
        (DRAG_ENTER, {"paths": names, "position": position}),
        (DRAG_OVER, {"position": position}),
        (DRAG_DROP, {"paths": names, "position": position}),
    ]
    assert DRAG_DROP == "tauri://drag-drop"


# ── XDND partner plumbing ────────────────────────────────────────────────────
def test_partner_command_passes_mode_geometry_and_args():
    argv = partner_command("/usr/bin/python3", "source", (1, 2.0, 3, 4), ["/tmp/a"])
    assert argv[0] == "/usr/bin/python3" and argv[1] == "-c"
    assert argv[3:] == ["source", "1", "2", "3", "4", "/tmp/a"]


def test_partner_command_refuses_an_unknown_mode():
    with pytest.raises(ValueError):
        partner_command("python3", "termiHub", (0, 0, 1, 1), [])


def test_uri_paths_decode_encoded_and_raw_file_uris():
    assert uri_paths(["file:///tmp/two%20words.txt", "file:///tmp/it's raw.txt", " "]) == [
        "/tmp/two words.txt",
        "/tmp/it's raw.txt",
    ]


@pytest.mark.skipif(sys.platform.startswith("linux"), reason="non-Linux refusal")
def test_xdnd_is_unavailable_off_linux():
    assert "Linux" in (xdnd.unavailable_reason() or "")


WINDOW = OsWindow(1, 100, 0, 0, 900, 620)


def test_free_region_prefers_the_right_of_the_window():
    assert free_region((1280, 1024), WINDOW, (260, 200)) == (920, 0)


def test_free_region_falls_back_below_then_raises():
    assert free_region((1000, 1024), WINDOW, (260, 200)) == (0, 640)
    with pytest.raises(OsInputUnavailable):
        free_region((900, 620), WINDOW, (260, 200))


# ── The native drag gesture ──────────────────────────────────────────────────
class FakeInput(OsInput):
    def __init__(self, pid: int, *, front: Optional[int] = None, **kw):
        super().__init__(pid, **kw)
        self.front = pid if front is None else front
        self.calls: list[tuple] = []

    def _frontmost_pid(self) -> Optional[int]:
        return self.front

    def _pointer_move(self, pid: int, x: int, y: int) -> None:
        self.calls.append(("move", x, y))

    def _pointer_button(self, pid: int, button: str, down: bool) -> None:
        self.calls.append(("button", button, down))


def test_native_drag_presses_travels_hovers_and_releases():
    fake = FakeInput(100, env=CI)
    hovered: list[int] = []
    native_drag(fake, (10, 10), [(300, 300), (50, 400)], hover=0.12, on_hover=hovered.append)
    buttons = [c for c in fake.calls if c[0] == "button"]
    assert buttons == [("button", "left", True), ("button", "left", False)]
    assert fake.calls[0] == ("move", 10, 10)
    moves = [c[1:] for c in fake.calls if c[0] == "move"]
    assert (300, 300) in moves and moves[-1] == (50, 400)
    assert set(hovered) == {0, 1}


def test_native_drag_refused_off_ci_presses_nothing():
    fake = FakeInput(100, env={})
    with pytest.raises(GlobalInjectionRefused):
        native_drag(fake, (10, 10), [(20, 20)], hover=0.0)
    assert ("button", "left", True) not in fake.calls


def test_native_drag_releases_even_when_a_move_is_refused():
    fake = FakeInput(100, env=CI)

    def steal_focus(_index: int) -> None:
        fake.front = 999  # a foreign window took the focus mid-drag

    with pytest.raises(GlobalInjectionRefused):
        native_drag(fake, (10, 10), [(200, 200)], hover=0.2, on_hover=steal_focus)
    assert fake.calls[-1] == ("button", "left", False)


def test_partner_env_drops_gtk_scaling():
    """#4997: XDND partners stay at scale 1 under a GDK_SCALE=2 lane."""
    env = partner_env({"GDK_SCALE": "2", "GDK_DPI_SCALE": "1", "DISPLAY": ":99"})
    assert env == {"DISPLAY": ":99"}


def test_device_pixel_ratio_check():
    """#4997: a scaled lane fails when the instance did not take the scale."""
    assert check_device_pixel_ratio({"devicePixelRatio": 1}, {}) == 1.0
    assert check_device_pixel_ratio({"devicePixelRatio": 2}, {EXPECT_DPR_ENV: "2"}) == 2.0
    with pytest.raises(AssertionError, match="wrong scale"):
        check_device_pixel_ratio({"devicePixelRatio": 1}, {EXPECT_DPR_ENV: "2"})


@pytest.mark.parametrize(
    ("geometry", "visible"),
    [((0, 0, 100, 100), True), ((-50, -50, 100, 100), True), ((-200, -200, 10, 10), False)],
)
def test_off_screen_helper_windows_are_not_targets(geometry, visible):
    assert on_screen(*geometry) is visible
