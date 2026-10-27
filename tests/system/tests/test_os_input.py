"""Unit tests for the OS-level input helpers (#4935) — no app, no display.

The safety rules are the point: a by-name target is refused before anything
runs, global injection needs a GitHub runner or the explicit opt-in, and every
global event is preceded by a frontmost-PID check. The Linux backend's
``xdotool`` command lines and the coordinate calibration are checked against
fakes.
"""

from __future__ import annotations

import sys
from typing import Optional, Sequence

import pytest

from termihub_harness import os_input
from termihub_harness.os_input import (
    ByNameTargetRefused,
    GlobalInjectionRefused,
    OsInput,
    OsInputUnavailable,
    OsWindow,
    ScreenMapper,
    global_injection_allowed,
    parse_combo,
    require_pid,
)
from termihub_harness.os_input.helper import helper_command
from termihub_harness.os_input.keymap import mac_keycode, us_key_for_char, win_vk
from termihub_harness.os_input.linux import LinuxOsInput, XWindowManager, combo_keysyms, keysym
from termihub_harness.os_input.macos import MacOsInput, combo_flags, fourcc

CI = {"GITHUB_ACTIONS": "true"}


# ── Target refusal ───────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "target", ["termiHub", "com.armaxri.termihub", "1234", "", "termihub.exe"]
)
def test_by_name_targets_are_refused(target):
    with pytest.raises(ByNameTargetRefused, match="by-name"):
        require_pid(target)


@pytest.mark.parametrize("target", [None, 0, -5, True, 3.0])
def test_non_pid_targets_are_refused(target):
    with pytest.raises(ByNameTargetRefused):
        require_pid(target)


def test_for_pid_refuses_a_name_before_building_a_backend():
    with pytest.raises(ByNameTargetRefused):
        os_input.for_pid("termiHub")  # type: ignore[arg-type]


def test_require_pid_accepts_a_pid():
    assert require_pid(4242) == 4242


# ── Global gate ──────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "env, allowed",
    [
        ({}, False),
        ({"GITHUB_ACTIONS": "false"}, False),
        ({"GITHUB_ACTIONS": "true"}, True),
        ({os_input.GLOBAL_OPT_IN_ENV: "1"}, True),
        ({os_input.GLOBAL_OPT_IN_ENV: "yes"}, False),
    ],
)
def test_global_injection_gate(env, allowed):
    assert global_injection_allowed(env) is allowed


class FakeInput(OsInput):
    """Records primitives; ``front`` is the PID reported frontmost."""

    def __init__(self, pid: int, *, front: Optional[int] = None, is_global: bool = True, **kw):
        super().__init__(pid, **kw)
        self.is_global = is_global
        self.front = pid if front is None else front
        self.screen = (1280, 1024)
        self.calls: list[tuple] = []

    def _windows(self, pid: int) -> list[OsWindow]:
        return [OsWindow(1, pid, 100, 50, 800, 600)]

    def _frontmost_pid(self) -> Optional[int]:
        return self.front

    def _screen_size(self) -> tuple[int, int]:
        return self.screen

    def _activate(self, window: OsWindow) -> None:
        self.calls.append(("activate", window.pid))
        self.front = window.pid

    def _key(self, pid: int, mods: Sequence[str], key: str) -> None:
        self.calls.append(("key", pid, tuple(mods), key))

    def _key_state(self, pid: int, key: str, down: bool) -> None:
        self.calls.append(("key_state", pid, key, down))

    def _type(self, pid: int, text: str) -> None:
        self.calls.append(("type", pid, text))

    def _pointer_move(self, pid: int, x: int, y: int) -> None:
        self.calls.append(("move", x, y))

    def _pointer_button(self, pid: int, button: str, down: bool) -> None:
        self.calls.append(("button", button, down))


def test_global_keys_refused_off_ci():
    fake = FakeInput(100, env={})
    with pytest.raises(GlobalInjectionRefused, match="GitHub runner"):
        fake.key("ctrl+c")
    assert fake.calls == []


def test_global_keys_refused_when_another_pid_is_frontmost():
    fake = FakeInput(100, front=999, env=CI)
    with pytest.raises(GlobalInjectionRefused, match="999"):
        fake.type_text("abc")
    assert fake.calls == []


def test_pointer_is_always_global_even_for_pid_routed_keys():
    fake = FakeInput(100, front=999, is_global=False, env={})
    fake.key("cmd+q")  # PID-routed: no frontmost requirement, no CI requirement
    assert fake.calls == [("key", 100, ("cmd",), "q")]
    with pytest.raises(GlobalInjectionRefused):
        fake.pointer_move(1, 2)


def test_pointer_needs_a_harness_window_frontmost_not_the_target():
    fake = FakeInput(100, front=555, env=CI)
    with pytest.raises(GlobalInjectionRefused):
        fake.click(1, 2)  # 555 is not harness-owned
    fake.allow_pid(555)
    fake.click(1, 2)  # a click from a helper window into the test instance
    assert ("button", "left", True) in fake.calls


def test_unknown_pids_are_refused_until_allowed():
    fake = FakeInput(100, env=CI)
    with pytest.raises(GlobalInjectionRefused, match="not the test instance"):
        fake.key("a", pid=555)
    fake.allow_pid(555)
    fake.activate(555)
    fake.key("a", pid=555)
    assert ("key", 555, (), "a") in fake.calls


def test_retarget_follows_a_relaunch_and_drops_the_old_pid():
    fake = FakeInput(100, env=CI)
    fake.retarget(200)
    with pytest.raises(GlobalInjectionRefused):
        fake.key("a", pid=100)
    fake.front = 200
    fake.key("a")
    assert fake.calls[-1] == ("key", 200, (), "a")


def test_drag_releases_the_button_even_when_a_move_is_refused():
    fake = FakeInput(100, env=CI)

    calls = {"n": 0}
    original = fake._frontmost_pid

    def flaky_front():
        calls["n"] += 1
        return original() if calls["n"] < 4 else 999

    fake._frontmost_pid = flaky_front  # type: ignore[method-assign]
    with pytest.raises(GlobalInjectionRefused):
        fake.drag((0, 0), (100, 0), steps=5, hold=0)
    assert fake.calls[-1] == ("button", "left", False)


def test_drag_moves_in_steps_to_the_end():
    fake = FakeInput(100, env=CI)
    fake.drag((0, 0), (100, 50), steps=4, hold=0)
    moves = [c for c in fake.calls if c[0] == "move"]
    assert moves[0] == ("move", 0, 0)
    assert moves[-1] == ("move", 100, 50)
    assert len(moves) == 5


# ── Combos and key maps ──────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "combo, parsed",
    [
        ("ctrl+shift+c", (["ctrl", "shift"], "c")),
        ("cmd+q", (["cmd"], "q")),
        ("Enter", ([], "enter")),
        ("A", ([], "A")),
        ("+", ([], "+")),
        ("shift++", (["shift"], "+")),
        ("altgr+e", (["altgr"], "e")),
    ],
)
def test_parse_combo(combo, parsed):
    assert parse_combo(combo) == parsed


@pytest.mark.parametrize("combo", ["", "hyper+x", "ctrl+"])
def test_parse_combo_rejects_bad_input(combo):
    with pytest.raises(ValueError):
        parse_combo(combo)


def test_linux_keysyms():
    assert combo_keysyms(["ctrl", "shift"], "c") == "ctrl+shift+c"
    assert combo_keysyms(["altgr"], "e") == "ISO_Level3_Shift+e"
    assert combo_keysyms(["ctrl", "shift"], "`") == "ctrl+shift+grave"
    assert keysym("caps_lock") == "Caps_Lock"
    assert keysym("'") == "apostrophe"
    assert keysym("f5") == "F5"
    assert keysym("dead_acute") == "dead_acute"


def _xprop_runner(windows: dict[str, str]):
    """A fake runner: ``xprop`` answers from ``windows`` (id → output), else fails."""

    def run(argv: Sequence[str]) -> str:
        key = "root" if argv[1] == "-root" else argv[2]
        if key not in windows:
            raise OsInputUnavailable(f"xprop: BadWindow {key}")
        return windows[key]

    return run


_WM_CHECK = "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400001"


def test_window_manager_running_when_its_check_window_answers():
    run = _xprop_runner({"root": _WM_CHECK, "0x400001": _WM_CHECK})
    assert XWindowManager(run=run).running()


def test_window_manager_not_running_when_the_root_property_is_stale():
    """#4979: an openbox that exited leaves the root's _NET_SUPPORTING_WM_CHECK
    behind. Trusting it made every later suite run without a window manager."""
    run = _xprop_runner({"root": _WM_CHECK})
    assert not XWindowManager(run=run).running()


def test_window_manager_not_running_without_the_root_property():
    run = _xprop_runner({"root": "_NET_SUPPORTING_WM_CHECK:  not found."})
    assert not XWindowManager(run=run).running()


def test_us_layout_char_map():
    assert us_key_for_char("a") == ("a", False)
    assert us_key_for_char("A") == ("a", True)
    assert us_key_for_char("~") == ("`", True)
    assert us_key_for_char(" ") == (" ", False)
    assert us_key_for_char("\n") == ("enter", False)
    assert us_key_for_char("é") is None


def test_mac_keycodes_and_flags():
    assert mac_keycode("q") == 12
    assert mac_keycode("e") == 14
    assert mac_keycode("caps_lock") == 57
    assert combo_flags(["cmd"]) == 0x100000
    assert combo_flags(["alt"], caps_lock=True) == 0x80000 | 0x10000
    assert fourcc("quit") == 0x71756974
    with pytest.raises(ValueError):
        mac_keycode("not-a-key")


class FakeQuartz:
    """The few Quartz calls :meth:`MacOsInput.key_repeat` makes, recorded."""

    kCGHIDEventTap = 0
    kCGKeyboardEventAutorepeat = 8

    def __init__(self) -> None:
        self.posted: list[tuple] = []

    def CGEventCreateKeyboardEvent(self, _source, code, down):  # noqa: N802
        return {"code": code, "down": down, "repeat": 0}

    def CGEventSetFlags(self, event, flags):  # noqa: N802
        event["flags"] = flags

    def CGEventSetIntegerValueField(self, event, field, value):  # noqa: N802
        assert field == self.kCGKeyboardEventAutorepeat
        event["repeat"] = value

    def CGEventPost(self, tap, event):  # noqa: N802
        self.posted.append(("tap", tap, event["code"], event["down"], event["repeat"]))

    def CGEventPostToPid(self, pid, event):  # noqa: N802
        self.posted.append(("pid", pid, event["code"], event["down"], event["repeat"]))


def mac_input(monkeypatch, *, front: int, env) -> tuple[MacOsInput, FakeQuartz]:
    quartz = FakeQuartz()
    monkeypatch.setitem(sys.modules, "Quartz", quartz)
    osi = MacOsInput(100, env=env)
    monkeypatch.setattr(osi, "_frontmost_pid", lambda: front)
    monkeypatch.setattr(MacOsInput, "KEY_DELAY", 0)
    return osi, quartz


def test_mac_key_repeat_posts_autorepeats_at_the_hid_tap(monkeypatch):
    # #4980: AppKit drops autorepeat key-downs posted to a PID, so a held key is
    # one key-down, the flagged repeats and a key-up, all at the HID tap.
    osi, quartz = mac_input(monkeypatch, front=100, env=CI)
    osi.key_repeat("e", 3, interval=0, delay=0)  # type: ignore[attr-defined]
    e = mac_keycode("e")
    assert quartz.posted == [
        ("tap", 0, e, True, 0),
        ("tap", 0, e, True, 1),
        ("tap", 0, e, True, 1),
        ("tap", 0, e, True, 1),
        ("tap", 0, e, False, 0),
    ]


def test_mac_key_repeat_is_global_and_refused_off_ci(monkeypatch):
    osi, quartz = mac_input(monkeypatch, front=100, env={})
    with pytest.raises(GlobalInjectionRefused):
        osi.key_repeat("e", 3, interval=0, delay=0)  # type: ignore[attr-defined]
    # Only the release of a key that was never pressed may go out.
    assert all(not down for *_, down, _repeat in quartz.posted)


def test_mac_key_repeat_stops_and_releases_when_focus_moves(monkeypatch):
    osi, quartz = mac_input(monkeypatch, front=100, env=CI)
    fronts = iter([100, 100, 999])
    monkeypatch.setattr(osi, "_frontmost_pid", lambda: next(fronts, 999))
    with pytest.raises(GlobalInjectionRefused):
        osi.key_repeat("e", 5, interval=0, delay=0)  # type: ignore[attr-defined]
    e = mac_keycode("e")
    assert quartz.posted == [
        ("tap", 0, e, True, 0),
        ("tap", 0, e, True, 1),
        ("tap", 0, e, False, 0),
    ]


def test_windows_virtual_keys():
    assert win_vk("c") == ord("C")
    assert win_vk("7") == ord("7")
    assert win_vk("f12") == 0x7B
    assert win_vk("`") == 0xC0
    assert win_vk("caps_lock") == 0x14


# ── Linux backend command lines ──────────────────────────────────────────────
class XdoRecorder:
    def __init__(self, replies: Optional[dict] = None, fail: Sequence[str] = ()):
        self.replies = replies or {}
        self.fail = set(fail)
        self.argv: list[list[str]] = []

    def __call__(self, argv: Sequence[str]) -> str:
        argv = list(argv)
        self.argv.append(argv)
        verb = argv[1] if len(argv) > 1 else argv[0]
        if verb in self.fail:
            raise OsInputUnavailable(f"{verb} failed")
        return self.replies.get(verb, "")


def test_linux_windows_are_found_by_pid_never_by_name():
    run = XdoRecorder(
        {
            "search": "11\n12\n",
            "getwindowgeometry": "WINDOW=11\nX=0\nY=0\nWIDTH=1280\nHEIGHT=800\nSCREEN=0\n",
        }
    )
    backend = LinuxOsInput(321, run=run, env=CI)
    windows = backend.windows()
    assert windows[0] == OsWindow(11, 321, 0, 0, 1280, 800)
    assert run.argv[0] == ["xdotool", "search", "--onlyvisible", "--pid", "321"]
    assert not any("--name" in a or "--class" in a or "--classname" in a for a in run.argv)


def test_linux_no_window_is_an_empty_list():
    backend = LinuxOsInput(321, run=XdoRecorder(fail=["search"]), env=CI)
    assert backend.windows() == []


def test_linux_activation_falls_back_without_a_window_manager():
    run = XdoRecorder({"getwindowfocus": "11\n", "getwindowpid": "321\n"}, fail=["windowactivate"])
    backend = LinuxOsInput(321, run=run, env=CI)
    backend._activate(OsWindow(11, 321, 0, 0, 10, 10))
    verbs = [a[1] for a in run.argv]
    assert verbs == ["windowactivate", "windowraise", "windowfocus"]


def test_linux_key_checks_focus_then_sends_xtest():
    run = XdoRecorder({"getwindowfocus": "11\n", "getwindowpid": "321\n"})
    backend = LinuxOsInput(321, run=run, env=CI)
    backend.key("ctrl+shift+c")
    assert [a[1] for a in run.argv] == ["getwindowfocus", "getwindowpid", "key"]
    assert run.argv[-1][-1] == "ctrl+shift+c"


def test_linux_key_refused_when_focus_is_elsewhere():
    run = XdoRecorder({"getwindowfocus": "11\n", "getwindowpid": "999\n"})
    backend = LinuxOsInput(321, run=run, env=CI)
    with pytest.raises(GlobalInjectionRefused):
        backend.key("a")
    assert not any(a[1] == "key" for a in run.argv)


def test_linux_type_presses_return_for_newlines():
    run = XdoRecorder({"getwindowfocus": "11\n", "getwindowpid": "321\n"})
    backend = LinuxOsInput(321, run=run, env=CI)
    backend.type_text("echo hi\n")
    sent = [a for a in run.argv if a[1] in ("type", "key")]
    assert sent[0][-1] == "echo hi"
    assert sent[1] == ["xdotool", "key", "Return"]


def test_linux_layout_change_is_refused_off_ci():
    backend = LinuxOsInput(321, run=XdoRecorder(), env={})
    with pytest.raises(GlobalInjectionRefused):
        backend.set_layout("us", "intl")


# ── Calibration ──────────────────────────────────────────────────────────────
class ProbeDriver:
    """Fake bridge: reports a trusted pointermove at a fixed client point."""

    def __init__(self, client=(400.0, 300.0), dpr=1.0, rect=None, sees=True):
        self.client, self.dpr, self.rect, self.sees = client, dpr, rect, sees

    def os_input_probe(self, test_id=None, *, reset=False):
        events = []
        if self.sees and not reset:
            events = [
                {
                    "type": "pointermove",
                    "isTrusted": True,
                    "clientX": self.client[0],
                    "clientY": self.client[1],
                }
            ]
        value = {"events": events, "devicePixelRatio": self.dpr, "hasFocus": True}
        if test_id:
            value["rect"] = self.rect
        return value


def test_calibration_maps_client_to_screen():
    fake = FakeInput(100, env=CI)  # window 100,50 800x600 → center (500, 350)
    driver = ProbeDriver(client=(400.0, 270.0), rect={"left": 10, "top": 20, "width": 100, "height": 40})
    screen = ScreenMapper.calibrate(fake, driver)
    assert screen.offset == (100.0, 80.0)
    assert screen.point("x") == (100 + 60, 80 + 40)
    assert screen.outside_point(10) == (500, 660)


def test_outside_point_falls_back_when_the_window_reaches_the_screen_bottom():
    fake = FakeInput(100, env=CI)  # window 100,50 800x600
    fake.screen = (1024, 640)
    screen = ScreenMapper.calibrate(fake, ProbeDriver())
    assert screen.outside_point(60) == (960, 350)  # right of the window
    fake.screen = (800, 600)
    with pytest.raises(OsInputUnavailable, match="no screen space"):
        ScreenMapper(fake, None, OsWindow(1, 100, 0, 0, 800, 600), (0, 0), 1.0).outside_point()


def test_calibration_honours_device_pixel_ratio():
    fake = FakeInput(100, env=CI)
    screen = ScreenMapper.calibrate(fake, ProbeDriver(client=(200.0, 150.0), dpr=2.0))
    assert screen.scale == 2.0
    assert screen.to_screen(200.0, 150.0) == (500.0, 350.0)


def test_calibration_fails_when_no_window_sees_the_pointer():
    fake = FakeInput(100, env=CI)
    with pytest.raises(OsInputUnavailable, match="calibration"):
        ScreenMapper.calibrate(fake, ProbeDriver(sees=False), timeout=0.3)


class LateProbeDriver(ProbeDriver):
    """Fake bridge whose webview misses the first ``misses`` calibration moves."""

    def __init__(self, misses: int, **kw):
        super().__init__(**kw)
        self.misses = misses
        self.resets = 0

    def os_input_probe(self, test_id=None, *, reset=False):
        if reset:
            self.resets += 1
        self.sees = self.resets > self.misses
        return super().os_input_probe(test_id, reset=reset)


def test_calibration_keeps_retrying_past_the_first_nudges_until_a_move_lands(monkeypatch):
    # Four missed rounds: more than the three nudges the old calibration tried.
    monkeypatch.setattr(os_input, "CALIBRATION_MOVE_WAIT", 0.05)
    fake = FakeInput(100, env=CI)
    driver = LateProbeDriver(4, client=(400.0, 300.0))
    screen = ScreenMapper.calibrate(fake, driver, timeout=10.0)
    assert driver.resets == 5
    assert fake.calls.count(("activate", 100)) >= 5  # re-activated every round
    assert screen.offset == (500 - 400 + 23, 350 - 300 + 17)  # round 5 = nudge (23, 17)


def test_calibration_failure_names_what_was_under_the_pointer():
    class Diagnosing(FakeInput):
        def _describe_point(self, x, y):
            return f"devtools-window@{x},{y}"

        def _describe_desktop(self):
            return "visible top-level windows: devtools"

    fake = Diagnosing(100, env=CI)
    with pytest.raises(OsInputUnavailable) as raised:
        ScreenMapper.calibrate(fake, ProbeDriver(sees=False), timeout=0.3)
    message = str(raised.value)
    assert "under the pointer devtools-window@500,350" in message
    assert "visible top-level windows: devtools" in message


def test_screen_point_rejects_an_unlaid_element():
    fake = FakeInput(100, env=CI)
    driver = ProbeDriver(rect={"left": 0, "top": 0, "width": 0, "height": 0})
    screen = ScreenMapper.calibrate(fake, driver)
    with pytest.raises(AssertionError, match="no laid-out box"):
        screen.point("hidden")


# ── Helper window ────────────────────────────────────────────────────────────
def test_helper_command_uses_appkit_on_macos_and_tk_elsewhere(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    argv = helper_command((1, 2, 3, 4))
    assert "AppKit" in argv[2] and argv[-4:] == ["1", "2", "3", "4"]
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr("termihub_harness.os_input.helper._has_tkinter", lambda python: True)
    assert "tkinter" in helper_command((1, 2, 3, 4))[2]


def test_helper_command_without_tkinter_is_unavailable(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr("termihub_harness.os_input.helper._has_tkinter", lambda python: False)
    with pytest.raises(OsInputUnavailable, match="python3-tk"):
        helper_command((1, 2, 3, 4))


def test_unavailable_reason_off_ci(monkeypatch):
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.delenv(os_input.GLOBAL_OPT_IN_ENV, raising=False)
    assert os_input.unavailable_reason() is not None


def test_for_window_shifts_the_offset_by_the_frame_delta():
    fake = FakeInput(100, env=CI)
    screen = ScreenMapper.calibrate(fake, ProbeDriver(client=(400.0, 300.0)))
    other = screen.for_window(None, OsWindow(2, 100, 140, 90, 500, 400))
    assert other.offset == (screen.offset[0] + 40, screen.offset[1] + 40)
    assert other.window.handle == 2

