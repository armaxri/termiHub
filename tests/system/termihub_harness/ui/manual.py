"""Operator-interaction helpers for guided-manual tests (issue #914).

``ManualUi`` is the bridge between the automatable harness setup and the
irreducibly-manual step. A guided test launches the app and builds its state
through the usual ``*Ui`` mixins, then calls :meth:`manual_step` /
:meth:`manual_confirm` / :meth:`manual_observe` for the human part. Each prompt
goes to the console, the operator answers pass/fail/skip, and the interaction is
recorded into the session report (written by ``conftest`` at the end).

The skip-by-default policy lives in ``conftest`` (collection adds a skip marker
unless ``--manual`` + a TTY are present), so by the time a helper here runs the
session is interactive. The helpers still degrade gracefully — a missing report
collector just means "don't record", and :meth:`manual_observe` only attaches a
screenshot once the bridge gains the verb from #900.
"""

from __future__ import annotations

import datetime
from typing import ClassVar, Optional

import pytest

from ..manual import ManualPrompter, ManualRecord, ManualResult, ManualSession
from .base import HarnessMixin


class ManualUi(HarnessMixin):
    """Console prompts for the human step of a guided-manual test."""

    _manual_prompter: ClassVar[ManualPrompter]
    _manual_session: ClassVar[Optional[ManualSession]]
    _manual_nodeid: str

    @pytest.fixture(autouse=True)
    def _manual_ui(self, request: pytest.FixtureRequest):
        """Bind the prompter, the session collector, and this test's node id.

        Autouse on the mixin, so any suite that opts into ``ManualUi`` gets the
        helpers wired without per-test boilerplate. The collector is shared
        across the run via ``config`` (set in ``conftest.pytest_configure``); if
        it is absent (e.g. an isolated unit test of the mixin) recording is a
        no-op.
        """
        self._manual_prompter = ManualPrompter()
        self._manual_session = getattr(request.config, "_manual_session", None)
        self._manual_nodeid = request.node.nodeid
        yield

    # ── Operator verbs ───────────────────────────────────────────────────────
    def manual_step(self, instruction: str, expected: str) -> None:
        """Ask the operator to perform a step and confirm the expected result.

        Prints the instruction + expected result, waits for the operator to act,
        then records pass/fail/skip. A *fail* raises ``AssertionError`` (the test
        fails); a *skip* raises ``pytest.skip``.
        """
        result = self._manual_prompter.step(instruction, expected)
        self._record("step", instruction, expected, result)
        self._enforce(result, instruction)

    def manual_confirm(self, question: str) -> bool:
        """Ask a yes/no question and return the answer (also recorded)."""
        answer = self._manual_prompter.confirm(question)
        result = ManualResult("pass" if answer else "fail")
        self._record("confirm", question, "operator answers yes", result)
        return answer

    def manual_observe(
        self, instruction: str, expected: str, *, label: Optional[str] = None
    ) -> None:
        """Confirm a result the harness already produced — no operator action.

        Use this (not :meth:`manual_step`) whenever the harness performed the
        work and the operator only *looks* — e.g. "termiHub issued Open in
        VS Code; confirm it opened". The prompt is framed as an observation
        ("Look at the result…") rather than an action, and a screenshot is
        attached when the bridge supports it (#900); until then it captures
        nothing, so visual carve-outs can already be written against this API.
        """
        screenshot = self._capture_screenshot(label)
        result = self._manual_prompter.step(
            instruction, expected, screenshot=screenshot, action=False
        )
        self._record("observe", instruction, expected, result, screenshot=screenshot)
        self._enforce(result, instruction)

    # ── Internals ────────────────────────────────────────────────────────────
    def _capture_screenshot(self, label: Optional[str]) -> Optional[str]:
        """Persist a bridge screenshot for this observation; return its file path.

        Delegates to :func:`artifacts.save_manual_screenshot`, which writes a PNG
        under the per-test artifacts dir and returns its path — never the raw
        ``data:image/png;base64,…`` URL the bridge produces (#900), which would
        flood the operator console and the report. Returns ``None`` when the
        bridge has no screenshot verb (older app) or capture fails.
        """
        from ..artifacts import save_manual_screenshot

        path = save_manual_screenshot(self.driver, self._manual_nodeid, label=label)
        return str(path) if path is not None else None

    def _record(
        self,
        kind: str,
        instruction: str,
        expected: str,
        result: ManualResult,
        *,
        screenshot: Optional[str] = None,
    ) -> None:
        if self._manual_session is None:
            return
        self._manual_session.add(
            ManualRecord(
                nodeid=self._manual_nodeid,
                kind=kind,
                instruction=instruction,
                expected=expected,
                status=result.status,
                note=result.note,
                timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                screenshot=screenshot,
            )
        )

    @staticmethod
    def _enforce(result: ManualResult, instruction: str) -> None:
        if result.status == "skip":
            pytest.skip(f"operator skipped: {instruction}")
        if result.status == "fail":
            suffix = f" — {result.note}" if result.note else ""
            raise AssertionError(f"operator marked FAIL: {instruction}{suffix}")
