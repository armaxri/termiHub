"""A product-run capture must show its step's screen (#5857), without an app.

Runs in the normal (per-PR) lane. Run ``20261123T215628Z`` handed the UI
reviewers four captures of the wrong screen: each step's end capture ran after
its own cleanup had closed the dialog or left the settings page. A step now
declares ``expect_testid``; its main capture checks that element is in frame
and otherwise fails the step as a clearly labelled *harness* error, whose
failure capture is never sent to a reviewer. Driven by a fake driver.
"""

from __future__ import annotations

import functools
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest

from termihub_harness.product_run import Recorder
from termihub_harness.product_run import capture_guard as guard_mod
from termihub_harness.product_run import settle as settle_mod
from termihub_harness.product_run import ui as ui_mod
from termihub_harness.product_run.capture_guard import (
    HARNESS_ERROR,
    WrongScreen,
    check_in_frame,
    parse_px,
    screen_problem,
    wrong_screen_message,
)
from termihub_harness.product_run.review import group_shots, is_wrong_screen_failure
from termihub_harness.product_run.ui import ProductRunUi

SETTLED = {"settled": True, "reasons": [], "fonts": "loaded", "busy": [], "throttledFrames": 0}
VIEW = (1280.0, 768.0)
IN_FRAME = {"x": 320, "y": 67, "width": 640, "height": 646}
BELOW_FOLD = {"x": 795, "y": 1300, "width": 930, "height": 180}


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


# ── the in-frame check ───────────────────────────────────────────────────────
def test_an_element_inside_the_window_is_in_frame():
    assert screen_problem("dialog", exists=True, rect=IN_FRAME, viewport=VIEW) is None


@pytest.mark.parametrize(
    "exists, rect, viewport, expected",
    [
        (False, None, VIEW, "dialog is not in the page"),
        (True, None, VIEW, "dialog could not be measured"),
        (True, {"x": 1}, VIEW, "dialog has an unreadable box"),
        (True, {"x": 0, "y": 0, "width": 0, "height": 10}, VIEW, "not rendered"),
        (True, {"x": -700, "y": 0, "width": 640, "height": 10}, VIEW, "outside the window"),
        (True, BELOW_FOLD, VIEW, "outside the 1280x768 window"),
        (True, {"x": 1300, "y": 10, "width": 40, "height": 10}, VIEW, "scroll it into view"),
    ],
)
def test_anything_out_of_frame_is_a_problem(exists, rect, viewport, expected):
    problem = screen_problem("dialog", exists=exists, rect=rect, viewport=viewport)
    assert problem is not None and expected in problem


def test_an_unknown_viewport_only_checks_the_box():
    assert screen_problem("group", exists=True, rect=BELOW_FOLD, viewport=None) is None


@pytest.mark.parametrize(
    "value, expected", [("1280px", 1280.0), (" 768px ", 768.0), (800, 800.0), ("auto", None),
                        ("px", None), (None, None)]
)
def test_css_pixel_values_parse(value, expected):
    assert parse_px(value) == expected


def test_the_message_says_harness_error_not_product_failure():
    message = wrong_screen_message("unlock-dialog-error", "it is not in the page", "the dialog")
    assert message.startswith(HARNESS_ERROR)
    assert "not a product failure" in message
    assert "unlock-dialog-error" in message and "the step should show: the dialog" in message


def test_the_check_waits_briefly_for_the_element_then_passes():
    clock = FakeClock()
    answers = iter(["dialog is not in the page", None])
    check_in_frame("dialog", lambda: next(answers), clock=clock, sleep=clock.sleep)
    assert clock.now == pytest.approx(guard_mod.GUARD_INTERVAL)


def test_the_check_raises_wrong_screen_after_its_timeout():
    clock = FakeClock()
    with pytest.raises(WrongScreen) as exc:
        check_in_frame(
            "dialog", lambda: "dialog is not in the page", timeout=1,
            clock=clock, sleep=clock.sleep,
        )
    assert str(exc.value).startswith(HARNESS_ERROR)
    assert isinstance(exc.value, AssertionError)


def test_a_probe_error_counts_as_not_yet_in_frame():
    clock = FakeClock()

    def probe() -> Optional[str]:
        raise RuntimeError("bridge reconnecting")

    with pytest.raises(WrongScreen, match="could not be checked .bridge reconnecting"):
        check_in_frame("dialog", probe, timeout=0.5, clock=clock, sleep=clock.sleep)


# ── the step's capture ───────────────────────────────────────────────────────
class FakeDriver:
    """A page whose elements come and go as the fake step "clicks"."""

    def __init__(self, visible: dict[str, dict[str, Any]]) -> None:
        self.visible = dict(visible)

    def exists(self, test_id: str) -> bool:
        return test_id in self.visible

    def measure_element(self, test_id: str, descendants=None) -> dict[str, Any]:
        return {"rect": self.visible[test_id]}

    def render_settled(self, test_id=None, *, scope=None, frames=2):
        if test_id and test_id not in self.visible:
            return {"settled": False, "reasons": [f"{test_id} is not in the page"]}
        return SETTLED

    def get_computed_style(self, prop, test_id=None):
        return {"width": "1280px", "height": "768px"}[prop]


class Suite(ProductRunUi):
    phase = "guard"


def _suite(tmp_path: Path, driver: FakeDriver, monkeypatch) -> Suite:
    rec = Recorder(tmp_path / "run", clock=lambda: "2026-11-24T00:00:00Z")
    rec.start(run_id="run", inputs={}, profile={"dev_name": "product-run-run"})
    suite = object.__new__(Suite)
    Suite.recorder = rec
    suite.app = SimpleNamespace(pid=None)
    suite.driver = driver  # type: ignore[attr-defined]
    suite._failed_steps = []
    clock = FakeClock()
    monkeypatch.setattr(
        ui_mod, "wait_settled",
        functools.partial(settle_mod.wait_settled, clock=clock, sleep=clock.sleep),
    )
    monkeypatch.setattr(
        ui_mod, "check_in_frame",
        functools.partial(guard_mod.check_in_frame, clock=clock, sleep=clock.sleep),
    )
    monkeypatch.setattr(ui_mod, "capture_window", lambda pid: SimpleNamespace(width=8, height=6))
    monkeypatch.setattr(ui_mod, "save_png", lambda frame, path: path.write_bytes(b"png"))
    return suite


def _step(suite: Suite, step_id: str) -> dict[str, Any]:
    return next(s for s in suite.recorder.load()["steps"] if s["id"] == step_id)


def test_cleanup_before_the_end_capture_fails_as_a_harness_error(tmp_path, monkeypatch):
    """The R-154 shape: the body cancels the dialog, the end capture shows the sidebar."""
    driver = FakeDriver({"automation-editor-dialog": IN_FRAME})
    suite = _suite(tmp_path, driver, monkeypatch)
    with suite.step("complaints.toasts.dialog", "Toast", expect="the editor open",
                    expect_testid="automation-editor-dialog"):
        del driver.visible["automation-editor-dialog"]  # cancel_clean_editor()
    step = _step(suite, "complaints.toasts.dialog")
    assert step["status"] == "fail"
    assert step["reason"].startswith(HARNESS_ERROR)
    assert "automation-editor-dialog is not in the page" in step["reason"]
    # Only the labelled failure capture; no main capture of the wrong screen.
    assert step["screenshots"] == ["shots/complaints.toasts.dialog--failure.png"]
    assert suite._failed_steps == ["complaints.toasts.dialog"]


def test_a_main_capture_taken_before_cleanup_replaces_the_end_capture(tmp_path, monkeypatch):
    """The fix: ``self.shot()`` while the dialog is open, then the cleanup."""
    driver = FakeDriver({"automation-editor-dialog": IN_FRAME})
    suite = _suite(tmp_path, driver, monkeypatch)
    with suite.step("complaints.toasts.dialog", "Toast", expect_testid="automation-editor-dialog"):
        suite.shot()
        del driver.visible["automation-editor-dialog"]
    step = _step(suite, "complaints.toasts.dialog")
    assert step["status"] == "pass", step.get("reason")
    assert step["screenshots"] == ["shots/complaints.toasts.dialog.png"]


def test_a_group_below_the_fold_fails_until_it_is_scrolled_into_view(tmp_path, monkeypatch):
    """The R-092 shape: Command marks under the fold of Settings ▸ Terminal."""
    driver = FakeDriver({"settings-command-marks": BELOW_FOLD})
    suite = _suite(tmp_path, driver, monkeypatch)
    with suite.step("settings.command-marks.grouped", "Marks",
                    expect_testid="settings-command-marks"):
        pass
    step = _step(suite, "settings.command-marks.grouped")
    assert step["status"] == "fail" and "outside the 1280x768 window" in step["reason"]

    driver.visible["settings-command-marks"] = {"x": 795, "y": 420, "width": 930, "height": 180}
    with suite.step("settings.command-marks.grouped-2", "Marks",
                    expect_testid="settings-command-marks"):
        pass
    assert _step(suite, "settings.command-marks.grouped-2")["status"] == "pass"


def test_labelled_captures_and_steps_without_a_testid_are_not_guarded(tmp_path, monkeypatch):
    driver = FakeDriver({})
    suite = _suite(tmp_path, driver, monkeypatch)
    with suite.step("plain", "No testid"):
        pass
    with suite.step("labelled", "Labelled", expect_testid="gone", screenshot=False):
        suite.shot(label="before")
    assert _step(suite, "plain")["status"] == "pass"
    assert _step(suite, "labelled")["status"] == "pass"


def test_a_product_failure_is_not_labelled_a_harness_error(tmp_path, monkeypatch):
    driver = FakeDriver({"unlock-dialog-error": IN_FRAME})
    suite = _suite(tmp_path, driver, monkeypatch)
    with suite.step("cred-feedback.unlock.wrong-password", "Unlock",
                    expect_testid="unlock-dialog-error"):
        raise AssertionError("Unlock flashed the success state on a failure")
    step = _step(suite, "cred-feedback.unlock.wrong-password")
    assert step["status"] == "fail" and not step["reason"].startswith(HARNESS_ERROR)


# ── the review never sees a wrong-screen capture ─────────────────────────────
def test_wrong_screen_failure_captures_stay_out_of_the_review(tmp_path):
    run = tmp_path / "run"
    (run / "shots").mkdir(parents=True)
    for name in ("a--failure.png", "a--before.png", "b--failure.png"):
        (run / "shots" / name).write_bytes(b"png")
    shots = [
        {"file": "shots/a--failure.png", "step": "x.a.one", "label": "failure"},
        {"file": "shots/a--before.png", "step": "x.a.one", "label": "before"},
        {"file": "shots/b--failure.png", "step": "x.a.two", "label": "failure"},
    ]
    (run / "shots" / "manifest.json").write_text(json.dumps({"shots": shots}))
    steps = [
        {"id": "x.a.one", "status": "fail", "reason": f"{HARNESS_ERROR}: the capture must show d"},
        {"id": "x.a.two", "status": "fail", "reason": "a real product failure"},
    ]
    (run / "results.json").write_text(json.dumps({"steps": steps}))
    files = [s["file"] for group in group_shots(run).values() for s in group]
    assert files == ["shots/a--before.png", "shots/b--failure.png"]
    assert is_wrong_screen_failure(shots[0], steps[0])
    assert not is_wrong_screen_failure(shots[1], steps[0])
    assert not is_wrong_screen_failure(shots[2], steps[1])
