"""The product run's settings dependency grade (#5844), without an app.

X server: only the current platform's hint, and "Stop X server when idle"
nested under "Provide X server automatically" — disabled and showing off while
the parent is off. Serial: no prefix count off Linux, and a note on where the
serial line settings live. Close confirmations: one choice instead of the two
overlapping toggles. The live measurement runs in the desktop phase's settings
dependency step; this file runs in the normal (per-PR) lane.
"""

from __future__ import annotations

import pytest

from termihub_harness.product_run.settings_dependencies import (
    CLOSE_CHOICES,
    OLD_CLOSE_TOGGLES,
    settings_dependency_problems,
)

HINTS = {
    "windows": "Download and start VcXsrv when an X11 session needs it.",
    "macos": "Start XQuartz when an X11 session needs it, and offer to install it if missing.",
    "linux": "Use your desktop's X server, with a hint when none can be reached.",
}


def _x(platform="macos", provide_on=False, **overrides):
    state = {
        "platform": platform,
        "provide_hint": HINTS[platform],
        "provide_on": provide_on,
        "stop_on": provide_on,
        "stop_disabled": not provide_on,
        "stop_nested": True,
        "stop_hint": "Only applies while termiHub provides the X server.",
    }
    state.update(overrides)
    return state


def _serial(platform="macos", **overrides):
    serial = {
        "platform": platform,
        "count": "40 / 42 enabled" if platform == "linux" else None,
        "connection_note": None if platform == "linux"
        else "Baud rate, data bits, parity and flow control are set on each serial connection.",
    }
    serial.update(overrides)
    return serial


def _good(platform="macos"):
    return {
        "x_server": [_x(platform, provide_on=False), _x(platform, provide_on=True)],
        "serial": _serial(platform),
        "safety": {"choice": "Always", "old_toggles": [], "options": list(CLOSE_CHOICES)},
    }


@pytest.mark.parametrize("platform", ["windows", "macos", "linux"])
def test_a_good_page_passes(platform):
    assert settings_dependency_problems(_good(platform)) == []


def test_nothing_measured_passes():
    assert settings_dependency_problems({}) == []


def test_the_platform_dump_hint_fails():
    # R-054: one hint listing every platform's behaviour.
    m = _good("macos")
    m["x_server"][0]["provide_hint"] = (
        "Windows: download & run VcXsrv automatically. macOS/Linux: use the detected/guided server."
    )
    problems = settings_dependency_problems(m)
    assert any("also describes windows" in p for p in problems)
    assert any("also describes linux" in p for p in problems)


def test_idle_stop_on_while_the_parent_is_off_fails():
    # R-054: "Stop X server when idle" ON while its parent is OFF.
    m = _good()
    m["x_server"][0].update(stop_on=True, stop_disabled=False)
    problems = settings_dependency_problems(m)
    assert "X server: idle stop reads on while the parent is off" in problems
    assert "X server: idle stop is editable while the parent is off" in problems


def test_an_unnested_idle_stop_fails():
    m = _good()
    m["x_server"][1]["stop_nested"] = False
    assert any("not nested" in p for p in settings_dependency_problems(m))


def test_a_disabled_idle_stop_under_an_on_parent_fails():
    m = _good()
    m["x_server"][1]["stop_disabled"] = True
    assert any("disabled although the parent is on" in p for p in settings_dependency_problems(m))


def test_an_unexplained_off_idle_stop_fails():
    m = _good()
    m["x_server"][0]["stop_hint"] = ""
    assert any("why idle stop is off" in p for p in settings_dependency_problems(m))


def test_the_prefix_count_off_linux_fails():
    # R-055: "42 / 42 enabled" on macOS, where the scan never runs.
    m = _good("macos")
    m["serial"]["count"] = "42 / 42 enabled"
    assert any("where the scan does not run" in p for p in settings_dependency_problems(m))


def test_no_pointer_to_the_serial_line_settings_fails():
    m = _good("windows")
    m["serial"]["connection_note"] = None
    assert any("serial line settings" in p for p in settings_dependency_problems(m))


def test_linux_keeps_its_prefix_count():
    m = _good("linux")
    m["serial"]["count"] = None
    assert any("no 'n / m enabled'" in p for p in settings_dependency_problems(m))


@pytest.mark.parametrize("toggle", OLD_CLOSE_TOGGLES)
def test_an_old_overlapping_close_toggle_fails(toggle):
    # R-056: two close toggles whose interaction on Cmd+W is unclear.
    m = _good()
    m["safety"]["old_toggles"] = [toggle]
    assert any(toggle in p for p in settings_dependency_problems(m))


def test_a_missing_close_choice_fails():
    m = _good()
    m["safety"]["choice"] = None
    assert any("no 'Ask before closing" in p for p in settings_dependency_problems(m))


def test_wrong_close_options_fail():
    m = _good()
    m["safety"]["options"] = ["Always", "Never"]
    assert any("options" in p for p in settings_dependency_problems(m))


def test_unopened_close_options_are_not_graded():
    m = _good()
    m["safety"]["options"] = None
    assert settings_dependency_problems(m) == []
