"""Product-run captures wait for a settled screen (#5643), without an app.

Runs in the normal (per-PR) lane: the settle poll and the way a capture that
never settles fails its step, driven by a fake driver.
"""

from __future__ import annotations

import functools
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from termihub_harness.product_run import Recorder
from termihub_harness.product_run import settle as settle_mod
from termihub_harness.product_run import ui as ui_mod
from termihub_harness.product_run.settle import (
    NotSettled,
    settle_reasons,
    settle_target,
    wait_settled,
)
from termihub_harness.product_run.ui import ProductRunUi

SETTLED = {"settled": True, "reasons": [], "fonts": "loaded", "busy": [], "throttledFrames": 0}
SPINNER = {
    "settled": False,
    "reasons": ["a loading placeholder is visible (.split-view__lazy-fallback)"],
    "fonts": "loaded",
    "busy": [".split-view__lazy-fallback"],
}


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


# ── the poll ─────────────────────────────────────────────────────────────────
def test_a_settled_result_has_no_reasons():
    assert settle_reasons(SETTLED) == []


@pytest.mark.parametrize(
    "result, expected",
    [
        (SPINNER, SPINNER["reasons"]),
        ({"settled": False, "reasons": []}, ["the page did not report a settled screen"]),
        ({"settled": True, "reasons": ["fonts"]}, ["fonts"]),
        (None, ["unreadable settle result: None"]),
    ],
)
def test_anything_but_a_clean_settled_result_is_not_settled(result, expected):
    assert settle_reasons(result) == expected


def test_the_poll_waits_through_the_spinner_until_the_form_renders():
    clock = FakeClock()
    results = iter([SPINNER, SPINNER, SETTLED])
    settled = wait_settled(lambda: next(results), clock=clock, sleep=clock.sleep, interval=0.5)
    assert settled.attempts == 3 and settled.waited == pytest.approx(1.0)
    assert settled.note().startswith("settled after 1.0s (3 probe(s)), fonts loaded")


def test_a_screen_that_never_settles_fails_with_the_last_reason():
    clock = FakeClock()
    with pytest.raises(NotSettled) as exc:
        wait_settled(
            lambda: SPINNER, what="the editor", timeout=2, clock=clock, sleep=clock.sleep
        )
    message = str(exc.value)
    assert message.startswith("the editor did not finish rendering within 2s")
    assert "split-view__lazy-fallback" in message
    assert isinstance(exc.value, AssertionError)


def test_a_probe_error_counts_as_not_yet_settled():
    clock = FakeClock()
    calls = iter([RuntimeError("bridge reconnecting"), SETTLED])

    def probe() -> dict[str, Any]:
        item = next(calls)
        if isinstance(item, Exception):
            raise item
        return item

    assert wait_settled(probe, clock=clock, sleep=clock.sleep).attempts == 2
    with pytest.raises(NotSettled, match="settle probe failed: boom"):
        wait_settled(
            lambda: (_ for _ in ()).throw(RuntimeError("boom")),
            timeout=1,
            clock=clock,
            sleep=clock.sleep,
        )


def test_the_target_names_what_the_capture_waited_for():
    assert settle_target(None, None) == "the screen"
    assert settle_target("name", None) == "name"
    assert settle_target("name", "editor") == "name (in editor)"
    assert settle_target("panel", "panel") == "panel"


# ── the capture ──────────────────────────────────────────────────────────────
class FakeDriver:
    def __init__(self, results: list[dict[str, Any]]) -> None:
        self.results = list(results)
        self.calls: list[tuple[Any, Any]] = []

    def render_settled(self, test_id=None, *, scope=None, frames=2):
        self.calls.append((test_id, scope))
        return self.results.pop(0) if len(self.results) > 1 else self.results[0]

    def get_computed_style(self, prop, test_id=None):
        return "800px"


class Suite(ProductRunUi):
    phase = "settle"


def _suite(tmp_path: Path, driver: FakeDriver, monkeypatch) -> Suite:
    rec = Recorder(tmp_path / "run", clock=lambda: "2026-11-13T00:00:00Z")
    rec.start(run_id="run", inputs={}, profile={"dev_name": "product-run-run"})
    suite = object.__new__(Suite)
    Suite.recorder = rec
    suite.app = SimpleNamespace(pid=None)
    suite.driver = driver  # type: ignore[attr-defined]
    suite._failed_steps = []
    clock = FakeClock()
    monkeypatch.setattr(
        ui_mod,
        "wait_settled",
        functools.partial(settle_mod.wait_settled, clock=clock, sleep=clock.sleep),
    )
    monkeypatch.setattr(ui_mod, "capture_window", lambda pid: SimpleNamespace(width=8, height=6))
    monkeypatch.setattr(ui_mod, "save_png", lambda frame, path: path.write_bytes(b"png"))
    return suite


def _step(suite: Suite, step_id: str) -> dict[str, Any]:
    return next(s for s in suite.recorder.load()["steps"] if s["id"] == step_id)


def test_a_capture_waits_for_the_expected_form_before_it_is_taken(tmp_path, monkeypatch):
    driver = FakeDriver([SPINNER, SETTLED])
    suite = _suite(tmp_path, driver, monkeypatch)
    with suite.step("themes.light", "Light", screenshot=False):
        suite.shot(label="editor", expect="connection-editor-name-input")
    step = _step(suite, "themes.light")
    assert step["status"] == "pass"
    assert driver.calls == [("connection-editor-name-input", None)] * 2
    assert any(e.startswith("capture editor: settled after") for e in step["evidence"])
    assert step["screenshots"] == ["shots/themes.light--editor.png"]


def test_a_capture_that_never_settles_fails_the_step_instead_of_shooting_a_spinner(
    tmp_path, monkeypatch
):
    driver = FakeDriver([SPINNER])
    suite = _suite(tmp_path, driver, monkeypatch)
    with suite.step("agent.create", "Agent"):
        suite.shot(label="editor", expect="connection-editor-name-input")
    step = _step(suite, "agent.create")
    assert step["status"] == "fail"
    assert "did not finish rendering" in step["reason"]
    assert "split-view__lazy-fallback" in step["reason"]
    # No "editor" capture; only the labelled failure capture, taken anyway.
    assert step["screenshots"] == ["shots/agent.create--failure.png"]
    assert any(e.startswith("failure capture not settled") for e in step["evidence"])
    assert suite._failed_steps == ["agent.create"]


def test_the_end_of_step_capture_also_waits_and_fails_the_step(tmp_path, monkeypatch):
    suite = _suite(tmp_path, FakeDriver([SPINNER]), monkeypatch)
    with suite.step("settings.categories", "Settings"):
        pass
    step = _step(suite, "settings.categories")
    assert step["status"] == "fail" and "did not finish rendering" in step["reason"]


def test_a_settled_end_of_step_capture_passes(tmp_path, monkeypatch):
    suite = _suite(tmp_path, FakeDriver([SETTLED]), monkeypatch)
    with suite.step("settings.categories", "Settings"):
        pass
    step = _step(suite, "settings.categories")
    assert step["status"] == "pass"
    assert step["screenshots"] == ["shots/settings.categories.png"]
