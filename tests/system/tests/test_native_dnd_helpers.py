"""Unit tests for the macOS/Windows native drag partners (#4998) — no app, no display.

Covers the partner plumbing (argv, per-OS program, one-folder sources, the
availability reason) and the macOS backend stamping a held modifier on its HID
pointer events, which is what makes an injected Cmd-click a Cmd-click.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness.os_input import native_dnd
from termihub_harness.os_input.macos import MacOsInput, combo_flags
from termihub_harness.os_input.native_dnd import (
    MAX_LIFETIME,
    NativeSource,
    NativeTarget,
    partner_command,
)

CI = {"GITHUB_ACTIONS": "true"}


# ── Partner plumbing ─────────────────────────────────────────────────────────
def test_partner_command_carries_mode_geometry_lifetime_and_args():
    argv = partner_command("target", (1.0, 2, 3, 4), ["/dest"], python="/py")
    assert argv[:2] == ["/py", "-c"]
    assert argv[2] == native_dnd.partner_script()
    assert argv[3:] == ["target", "1", "2", "3", "4", str(MAX_LIFETIME), "/dest"]


def test_partner_command_defaults_to_the_harness_interpreter():
    assert partner_command("source", (0, 0, 1, 1), [])[0] == sys.executable


def test_partner_command_refuses_an_unknown_mode():
    with pytest.raises(ValueError, match="unknown native drag partner mode"):
        partner_command("sideways", (0, 0, 1, 1), [])


@pytest.mark.parametrize(
    ("platform", "marker"), [("darwin", "NSDraggingSource"), ("win32", "DoDragDrop")]
)
def test_partner_script_is_the_platform_program(monkeypatch, platform, marker):
    monkeypatch.setattr(native_dnd.sys, "platform", platform)
    assert marker in native_dnd.partner_script()


@pytest.mark.parametrize("script", [native_dnd._APPKIT_SCRIPT, native_dnd._WIN32_SCRIPT])
def test_partner_scripts_compile(script):
    compile(script, "<partner>", "exec")


def test_partners_are_unavailable_off_macos_and_windows(monkeypatch):
    monkeypatch.setattr(native_dnd.sys, "platform", "linux")
    assert "XDND" in (native_dnd.unavailable_reason() or "")
    monkeypatch.setattr(native_dnd.sys, "platform", "win32")
    assert native_dnd.unavailable_reason() is None


def test_source_offers_files_of_one_folder_only(tmp_path):
    (tmp_path / "sub").mkdir()
    NativeSource([tmp_path / "a", tmp_path / "b"], (0, 0, 10, 10))
    with pytest.raises(ValueError, match="one folder"):
        NativeSource([tmp_path / "a", tmp_path / "sub" / "b"], (0, 0, 10, 10))
    with pytest.raises(ValueError, match="one folder"):
        NativeSource([], (0, 0, 10, 10))


def test_target_reports_dropped_paths_from_its_drop_events(tmp_path):
    target = NativeTarget(tmp_path, (0, 0, 10, 10))
    target._lines = [  # noqa: SLF001 — what the pump would have read
        {"event": "motion"},
        {"event": "drop", "paths": ["/a", "/b"]},
        {"event": "drop", "paths": ["/c"]},
    ]
    assert target.dropped_paths() == ["/a", "/b", "/c"]
    assert target.mode == "target" and target.dest == tmp_path


def test_partner_without_its_program_says_why(monkeypatch, tmp_path):
    monkeypatch.setattr(native_dnd.sys, "platform", "linux")
    with pytest.raises(native_dnd.OsInputUnavailable, match="XDND"):
        NativeTarget(tmp_path, (0, 0, 10, 10)).command()


# ── macOS: a held modifier rides on the HID pointer events ───────────────────
class FakeQuartz:
    """The Quartz calls the macOS pointer and key paths make, recorded."""

    kCGHIDEventTap = 0
    kCGMouseEventClickState = 1
    kCGEventMouseMoved = 5
    kCGEventLeftMouseDown = 1
    kCGEventLeftMouseUp = 2
    kCGEventLeftMouseDragged = 6
    kCGEventRightMouseDown = 3
    kCGEventRightMouseUp = 4
    kCGEventRightMouseDragged = 7
    kCGMouseButtonLeft = 0
    kCGMouseButtonRight = 1

    def __init__(self) -> None:
        self.mouse: list[tuple[int, int]] = []
        self.keys: list[tuple[int, bool, int]] = []

    def CGEventCreateMouseEvent(self, _source, kind, _point, _button):  # noqa: N802
        return {"kind": kind, "flags": 0}

    def CGEventCreateKeyboardEvent(self, _source, code, down):  # noqa: N802
        return {"code": code, "down": down, "flags": 0}

    def CGEventSetIntegerValueField(self, event, field, value):  # noqa: N802
        pass

    def CGEventSetFlags(self, event, flags):  # noqa: N802
        event["flags"] = flags

    def CGEventPost(self, _tap, event):  # noqa: N802
        self.mouse.append((event["kind"], event["flags"]))

    def CGEventPostToPid(self, _pid, event):  # noqa: N802
        self.keys.append((event["code"], event["down"], event["flags"]))


@pytest.fixture
def mac(monkeypatch) -> tuple[MacOsInput, FakeQuartz]:
    quartz = FakeQuartz()
    monkeypatch.setitem(sys.modules, "Quartz", quartz)
    osi = MacOsInput(100, env=CI)
    monkeypatch.setattr(osi, "_frontmost_pid", lambda: 100)
    monkeypatch.setattr(MacOsInput, "KEY_DELAY", 0)
    return osi, quartz


def test_mac_click_while_cmd_is_held_is_a_cmd_click(mac):
    osi, quartz = mac
    cmd = combo_flags(["cmd"])
    osi.key_down("cmd")
    osi.click(10, 20)
    osi.key_up("cmd")
    osi.click(10, 20)
    q = FakeQuartz
    assert quartz.mouse == [
        (q.kCGEventMouseMoved, cmd),
        (q.kCGEventLeftMouseDown, cmd),
        (q.kCGEventLeftMouseUp, cmd),
        (q.kCGEventMouseMoved, 0),
        (q.kCGEventLeftMouseDown, 0),
        (q.kCGEventLeftMouseUp, 0),
    ]
    # The modifier key events themselves carry the modifier state, as real ones do.
    assert [(down, flags) for _code, down, flags in quartz.keys] == [(True, cmd), (False, 0)]


def test_mac_plain_key_down_does_not_stamp_pointer_events(mac):
    osi, quartz = mac
    osi.key_down("e")
    osi.click(1, 1)
    osi.key_up("e")
    assert all(flags == 0 for _kind, flags in quartz.mouse)
