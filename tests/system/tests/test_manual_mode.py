"""Unit tests for guided-manual mode (issue #914).

Machinery group (no app): these assert the pure pieces of the guided-manual
mechanism — the skip decision, the operator prompter against scripted input, the
report builder/writer, and that the ``ManualUi`` mixin composes ahead of
:class:`SystemTest` like the other ``*Ui`` mixins. They run anywhere without a
build, like the protocol, lookup, and mixin-composition tests.
"""

from __future__ import annotations

import datetime
import json

import pytest

from termihub_harness import (
    ManualPrompter,
    ManualRecord,
    ManualResult,
    ManualSession,
    ManualUi,
    SystemTest,
    build_manual_report,
    manual_skip_reason,
    write_manual_report,
)
from termihub_harness.manual import render_markdown


# ── Skip decision ────────────────────────────────────────────────────────────
class TestManualSkipReason:
    def test_disabled_skips_by_default(self):
        reason = manual_skip_reason(
            enabled=False, interactive=True, selected_platform="linux", platforms=None
        )
        assert reason and "--manual" in reason

    def test_non_interactive_skips_even_when_enabled(self):
        reason = manual_skip_reason(
            enabled=True, interactive=False, selected_platform="linux", platforms=None
        )
        assert reason and "TTY" in reason

    def test_enabled_interactive_no_platform_runs(self):
        assert (
            manual_skip_reason(
                enabled=True,
                interactive=True,
                selected_platform="linux",
                platforms=None,
            )
            is None
        )

    def test_platform_mismatch_skips(self):
        reason = manual_skip_reason(
            enabled=True,
            interactive=True,
            selected_platform="linux",
            platforms=["macos"],
        )
        assert reason and "linux" in reason

    def test_platform_match_runs(self):
        assert (
            manual_skip_reason(
                enabled=True,
                interactive=True,
                selected_platform="macos",
                platforms=["macos", "windows"],
            )
            is None
        )

    def test_all_platform_token_runs_everywhere(self):
        assert (
            manual_skip_reason(
                enabled=True,
                interactive=True,
                selected_platform="windows",
                platforms=["all"],
            )
            is None
        )


# ── Operator prompter ────────────────────────────────────────────────────────
def _scripted(answers):
    """A ``ManualPrompter`` reading from ``answers`` into a captured buffer."""
    pending = list(answers)
    captured: list[str] = []

    def input_fn(prompt: str) -> str:
        captured.append(prompt)
        return pending.pop(0)

    prompter = ManualPrompter(input_fn=input_fn, output=captured.append)
    return prompter, captured


class TestManualPrompter:
    def test_step_pass(self):
        prompter, _ = _scripted(["", "p"])  # Enter to act, then [p]ass
        result = prompter.step("Do the thing", "It works")
        assert result == ManualResult("pass")

    def test_step_fail_captures_note(self):
        prompter, _ = _scripted(["", "f", "looked wrong"])
        result = prompter.step("Do the thing", "It works")
        assert result.status == "fail"
        assert result.note == "looked wrong"

    def test_step_skip(self):
        prompter, _ = _scripted(["", "s"])
        assert prompter.step("Do the thing", "It works").status == "skip"

    def test_step_reprompts_on_invalid_choice(self):
        prompter, captured = _scripted(["", "x", "p"])
        assert prompter.step("Do it", "Works").status == "pass"
        assert any("Please enter one of" in line for line in captured)

    def test_step_presents_instruction_and_expected(self):
        prompter, captured = _scripted(["", "p"])
        prompter.step("Click export", "A save dialog opens")
        blob = "\n".join(captured)
        assert "Click export" in blob
        assert "A save dialog opens" in blob

    def test_step_action_frames_as_something_to_perform(self):
        prompter, captured = _scripted(["", "p"])
        prompter.step("Click export", "A save dialog opens")  # action=True default
        blob = "\n".join(captured)
        assert "MANUAL STEP" in blob
        assert "Perform the step" in blob

    def test_step_observe_frames_as_something_to_look_at(self):
        # An observation must not tell the operator to "perform" a step the
        # harness already did — it should ask them to look at the result (#957).
        prompter, captured = _scripted(["", "p"])
        prompter.step("VS Code was told to open", "It opens", action=False)
        blob = "\n".join(captured)
        assert "OBSERVE RESULT" in blob
        assert "Look at the result" in blob
        assert "Perform the step" not in blob
        assert "MANUAL STEP" not in blob

    def test_confirm_yes_no(self):
        yes, _ = _scripted(["y"])
        no, _ = _scripted(["n"])
        assert ManualPrompter.confirm(yes, "Does it blink?") is True
        assert no.confirm("Does it blink?") is False

    def test_eof_terminates_with_safe_default(self):
        def input_fn(_prompt: str) -> str:
            raise EOFError

        prompter = ManualPrompter(input_fn=input_fn, output=lambda _s: None)
        # A closed / non-interactive stream must not loop forever: confirm floors
        # to "no" and a step verdict floors to "skip".
        assert prompter.confirm("ok?") is False
        assert prompter.step("do it", "works").status == "skip"


# ── Report building / writing ────────────────────────────────────────────────
def _record(status: str, **kw) -> ManualRecord:
    return ManualRecord(
        nodeid=kw.get("nodeid", "tests/test_x.py::T::test_a"),
        kind=kw.get("kind", "step"),
        instruction=kw.get("instruction", "do it"),
        expected=kw.get("expected", "works"),
        status=status,
        timestamp="2026-06-29T00:00:00+00:00",
        note=kw.get("note"),
    )


class TestManualReport:
    def _times(self):
        start = datetime.datetime(2026, 6, 29, 12, 0, 0, tzinfo=datetime.timezone.utc)
        end = start + datetime.timedelta(seconds=90)
        return start, end

    def test_summary_counts(self):
        start, end = self._times()
        report = build_manual_report(
            [_record("pass"), _record("fail"), _record("skip"), _record("pass")],
            started_at=start,
            completed_at=end,
            selected_platform="linux",
        )
        assert report["summary"] == {
            "total": 4,
            "passed": 2,
            "failed": 1,
            "skipped": 1,
        }
        assert report["session"]["duration_seconds"] == 90
        assert report["environment"]["platform"] == "linux"

    def test_markdown_lists_each_record(self):
        start, end = self._times()
        report = build_manual_report(
            [_record("fail", instruction="Export", note="no dialog")],
            started_at=start,
            completed_at=end,
            selected_platform="macos",
        )
        md = render_markdown(report)
        assert "Export" in md
        assert "no dialog" in md
        assert "fail" in md

    def test_write_produces_json_and_markdown(self, tmp_path):
        start, end = self._times()
        path = write_manual_report(
            [_record("pass")],
            tmp_path,
            started_at=start,
            completed_at=end,
            selected_platform="linux",
        )
        assert path is not None and path.exists()
        assert path.suffix == ".json"
        assert path.with_suffix(".md").exists()
        data = json.loads(path.read_text())
        assert data["summary"]["passed"] == 1
        assert path.name.startswith("manual-")
        assert "linux" in path.name

    def test_write_no_records_writes_nothing(self, tmp_path):
        start, end = self._times()
        assert (
            write_manual_report([], tmp_path, started_at=start, completed_at=end)
            is None
        )
        assert list(tmp_path.iterdir()) == []


# ── Mixin composition ────────────────────────────────────────────────────────
class TestManualUiComposition:
    def test_manual_ui_composes_ahead_of_systemtest(self):
        class Suite(ManualUi, SystemTest):
            pass

        mro = Suite.__mro__
        assert mro.index(ManualUi) < mro.index(SystemTest)
        for verb in ("manual_step", "manual_confirm", "manual_observe"):
            assert callable(getattr(Suite, verb))

    def test_session_collects_records(self):
        session = ManualSession()
        session.add(_record("pass"))
        session.add(_record("fail"))
        assert [r.status for r in session.records] == ["pass", "fail"]


class _FakeDriver:
    """A driver with no ``screenshot`` verb (#900 not yet wired)."""


class TestManualUiBehavior:
    """Exercise the helper recording + fail/skip enforcement without an app."""

    def _ui(self, answers) -> ManualUi:
        ui = ManualUi.__new__(ManualUi)  # bypass the autouse fixture
        prompter, _ = _scripted(answers)
        ui._manual_prompter = prompter
        ui._manual_session = ManualSession()
        ui._manual_nodeid = "tests/x.py::T::test"
        ui.driver = _FakeDriver()
        return ui

    def test_step_pass_records(self):
        ui = self._ui(["", "p"])
        ui.manual_step("do it", "works")
        rec = ui._manual_session.records[-1]
        assert rec.status == "pass" and rec.kind == "step"

    def test_step_fail_raises_and_records(self):
        ui = self._ui(["", "f", "looked wrong"])
        with pytest.raises(AssertionError, match="looked wrong"):
            ui.manual_step("do it", "works")
        assert ui._manual_session.records[-1].status == "fail"

    def test_step_skip_raises_pytest_skip(self):
        ui = self._ui(["", "s"])
        with pytest.raises(pytest.skip.Exception):
            ui.manual_step("do it", "works")
        assert ui._manual_session.records[-1].status == "skip"

    def test_confirm_records_and_returns(self):
        ui = self._ui(["y"])
        assert ui.manual_confirm("does it blink?") is True
        assert ui._manual_session.records[-1].status == "pass"

    def test_observe_without_screenshot_verb_records_none(self):
        ui = self._ui(["", "p"])
        ui.manual_observe("look", "green", label="shot")
        rec = ui._manual_session.records[-1]
        assert rec.kind == "observe" and rec.screenshot is None

    def test_recording_is_noop_without_session(self):
        ui = self._ui(["", "p"])
        ui._manual_session = None
        ui.manual_step("do it", "works")  # must not raise
