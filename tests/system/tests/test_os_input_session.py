"""Unit tests for how the OS-input step meets its environment (#6148) — no app.

- An *environment refusal* (global input not allowed here, another termiHub
  alive, a host that cannot inject) is the same for every test of the step, so
  the first one ends the session with one clear message naming the lane and
  the cause, instead of failing every test the same way (TST-002).
- A per-test miss is not one: a calibration that found no window, or a
  frontmost window that is not the test instance's, stays an ordinary failure
  (a cover is stepped around, #6143/#6145, not turned into a refusal).
- A native dialog a failed test left open is closed before the next test
  (TST-012).
- The step runs with no reruns.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace
from typing import Optional, Sequence

import pytest

from termihub_harness.os_input import (
    ForeignAppAlive,
    GlobalInjectionRefused,
    OsInput,
    OsInputUnavailable,
    OsWindow,
)
from termihub_harness.os_input.base import EnvironmentRefusal, HostUnavailable
from termihub_harness.os_input.session import (
    close_leftover_dialogs,
    environment_refusal,
    stop_on_environment_refusal,
)

CI = {"GITHUB_ACTIONS": "true"}
REPO = Path(__file__).resolve().parents[3]


class FakeInput(OsInput):
    """Windows and a frontmost PID on demand; records keys."""

    def __init__(self, pid: int, *, env=None, front: Optional[int] = None):
        super().__init__(pid, env=CI if env is None else env)
        self.is_global = True
        self.front = pid if front is None else front
        self.extra: list[OsWindow] = []
        self.keys: list[str] = []
        self.closes_on_escape = True
        self.key_error: Optional[Exception] = None

    def _end_own_leaks(self):
        pass

    def _foreign_apps(self, timeout):
        return []

    @staticmethod
    def _describe_app_pid(pid):
        return ""

    def _windows(self, pid: int) -> list[OsWindow]:
        return [OsWindow(1, pid, 0, 0, 800, 600), *self.extra]

    def _frontmost_pid(self) -> Optional[int]:
        return self.front

    def _screen_size(self):
        return (1280, 1024)

    def _activate(self, window):
        self.front = window.pid

    def _key(self, pid: int, mods: Sequence[str], key: str) -> None:
        if self.key_error is not None:
            raise self.key_error
        self.keys.append("+".join([*mods, key]))
        if key == "escape" and self.closes_on_escape:
            self.extra.clear()

    def _key_state(self, pid, key, down):
        pass

    def _type(self, pid, text):
        pass

    def _pointer_move(self, pid, x, y):
        pass

    def _pointer_button(self, pid, button, down):
        pass


# ── Which failures are environment refusals ─────────────────────────────────
def _raised(fn) -> BaseException:
    with pytest.raises(BaseException) as info:
        fn()
    return info.value


def test_global_input_not_allowed_is_an_environment_refusal():
    exc = _raised(lambda: FakeInput(100, env={}).key("ctrl+c"))
    assert isinstance(exc, GlobalInjectionRefused)
    assert isinstance(exc, EnvironmentRefusal)
    assert "GitHub runner" in (environment_refusal(exc) or "")


def test_a_foreign_app_is_an_environment_refusal():
    exc = ForeignAppAlive("another termiHub process is alive")
    assert environment_refusal(exc) == "another termiHub process is alive"


def test_a_host_that_cannot_inject_is_an_environment_refusal():
    exc = HostUnavailable("xdotool is not installed")
    assert isinstance(exc, OsInputUnavailable)
    assert environment_refusal(exc) == "xdotool is not installed"


def test_a_frontmost_mismatch_is_not_an_environment_refusal():
    # A cover or an alert in front is per moment: stepped around, or one failure.
    exc = _raised(lambda: FakeInput(100, front=999).key("ctrl+c"))
    assert isinstance(exc, GlobalInjectionRefused)
    assert environment_refusal(exc) is None


@pytest.mark.parametrize(
    "exc",
    [
        OsInputUnavailable("no window of PID 100 received the calibration pointer move"),
        AssertionError("the caret moved"),
        GlobalInjectionRefused("PID 5 is not the test instance"),
    ],
)
def test_per_test_failures_are_not_environment_refusals(exc):
    assert environment_refusal(exc) is None


# ── Ending the session once ─────────────────────────────────────────────────
def _item(nodeid="tests/test_os_input_keyboard.py::T::test_a"):
    session = SimpleNamespace(shouldstop=False)
    return SimpleNamespace(nodeid=nodeid, session=session)


def _call(exc: Optional[BaseException]):
    excinfo = None
    if exc is not None:
        try:
            raise exc
        except BaseException:  # noqa: BLE001 - building an ExceptionInfo
            excinfo = pytest.ExceptionInfo.from_current()
    return SimpleNamespace(excinfo=excinfo)


def test_the_first_refusal_stops_the_session_naming_lane_and_cause():
    item = _item()
    stopped = stop_on_environment_refusal(
        item, _call(HostUnavailable("Accessibility is not granted")), lane="os-input-macos"
    )
    assert stopped
    message = item.session.shouldstop
    assert "os-input-macos" in message
    assert "Accessibility is not granted" in message
    assert "test_a" in message


def test_the_lane_falls_back_to_os_input():
    item = _item()
    stop_on_environment_refusal(item, _call(ForeignAppAlive("PID 7 alive")), lane=None)
    assert "os-input" in item.session.shouldstop


@pytest.mark.parametrize(
    "exc", [None, AssertionError("x"), OsInputUnavailable("calibration missed")]
)
def test_other_outcomes_leave_the_session_running(exc):
    item = _item()
    assert not stop_on_environment_refusal(item, _call(exc), lane="os-input-macos")
    assert item.session.shouldstop is False


def test_an_earlier_stop_reason_is_kept():
    item = _item()
    item.session.shouldstop = "stopping after 1 failures"
    stop_on_environment_refusal(item, _call(HostUnavailable("x")), lane="os-input-macos")
    assert item.session.shouldstop == "stopping after 1 failures"


# ── Leftover native dialogs ─────────────────────────────────────────────────
DIALOG = OsWindow(42, 100, 100, 100, 400, 300, "Save As")


def test_a_leftover_dialog_is_closed_with_escape():
    osi = FakeInput(100)
    baseline = {w.handle for w in osi.windows()}
    osi.extra = [DIALOG]
    closed = close_leftover_dialogs(osi, baseline, settle=0.0)
    assert osi.keys == ["escape"]
    assert closed and "Save As" in closed[0]
    assert not osi.native_dialog_open(baseline)


def test_nothing_is_pressed_without_a_dialog():
    osi = FakeInput(100)
    baseline = {w.handle for w in osi.windows()}
    assert close_leftover_dialogs(osi, baseline, settle=0.0) == []
    assert osi.keys == []


def test_a_stubborn_dialog_gets_a_bounded_number_of_tries():
    osi = FakeInput(100)
    baseline = {w.handle for w in osi.windows()}
    osi.extra = [DIALOG]
    osi.closes_on_escape = False
    close_leftover_dialogs(osi, baseline, attempts=3, settle=0.0)
    assert osi.keys == ["escape"] * 3


def test_closing_never_raises():
    osi = FakeInput(100)
    baseline = {w.handle for w in osi.windows()}
    osi.extra = [DIALOG]
    osi.key_error = GlobalInjectionRefused("frontmost window belongs to PID 9")
    assert close_leftover_dialogs(osi, baseline, settle=0.0) == []


# ── The step itself ─────────────────────────────────────────────────────────
def _os_input_step_run() -> str:
    workflow = (REPO / ".github/workflows/system-integration.yml").read_text(encoding="utf-8")
    m = re.search(r"- name: Run the OS-input grades.*?\n\s+run: ([^\n]+)", workflow, re.S)
    assert m, "the OS-input step is missing from system-integration.yml"
    return m.group(1)


def test_the_os_input_step_runs_without_reruns():
    run = _os_input_step_run()
    assert "--reruns 0" in run
    assert "--reruns 2" not in run and "--reruns-delay" not in run


@pytest.mark.parametrize("lane", ["os-input-macos", "os-input-windows"])
def test_the_os_input_rerun_budget_is_zero(lane):
    import json

    budget = json.loads(
        (REPO / f"tests/system/rerun-budget.d/{lane}.json").read_text(encoding="utf-8")
    )
    assert budget["max_reruns"] == {lane: 0}
