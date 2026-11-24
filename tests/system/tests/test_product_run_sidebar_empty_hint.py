"""Product run: the empty Connections sidebar carries no experimental note (#5954).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). #5873 shaped the experimental signpost
in the empty Connections card as one sentence and one button. The next UI
review (#5954) found it in the wrong place: "Workflows are still experimental.
Turn on in Settings." read as if connections needed an experimental switch.
The note moved to the Workflows view (graded in
``test_product_run_workflows_experimental_note.py``); this grade checks the
Connections empty state, with experimental features off and on, says nothing
about them.

The ``test_grade_*`` functions grade fixed text without an app and run in the
normal lane.
"""

from __future__ import annotations

import pytest

from termihub_harness import SettingsUi, SidebarUi, SystemTest, TabsUi
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.sidebar_empty_hint import (
    CONNECTIONS_EMPTY,
    connections_empty_problems,
)

TOGGLE = "settings-experimental-features"
CARD_TEXT = "No connections yet Create your first connection to get started. New connection"


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_connections_card_without_note_passes():
    assert connections_empty_problems(CARD_TEXT) == []


def test_grade_old_workflows_note_in_connections_fails():
    old = CARD_TEXT + " Workflows are still experimental. Turn on in Settings"
    problems = connections_empty_problems(old)
    assert any("'experimental'" in p for p in problems)
    assert any("'workflow'" in p for p in problems)
    assert any("'turn on'" in p for p in problems)


def test_grade_missing_card_fails():
    assert connections_empty_problems(None) == ["no empty-state card on the Connections sidebar"]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunSidebarEmptyHint(ProductRunUi, SettingsUi, SidebarUi, TabsUi, SystemTest):
    phase = "Empty sidebar signpost"
    request_timeout = 60.0

    def _set_experimental(self, on: bool) -> None:
        if self._experimental_enabled() == on:
            return
        self.open_settings_category("general")
        self.wait(lambda: self.driver.exists(TOGGLE), what="the experimental-features toggle")
        self.driver.click(TOGGLE)
        self.wait(lambda: self._experimental_enabled() == on, what=f"experimental features {on}")
        self.close_all_tabs()

    def _grade_card(self, label: str) -> None:
        self.switch_to_connections_sidebar()
        if not self.driver.exists(CONNECTIONS_EMPTY):
            pytest.skip("the run already has saved connections; no empty state")
        text = self.driver.get_text(CONNECTIONS_EMPTY)
        self.shot(label=label)
        self.evidence(f"card {text!r}")
        problems = connections_empty_problems(text)
        assert not problems, problems

    def test_10_no_note_with_experimental_off(self):
        self._set_experimental(False)
        with self.step(
            "sidebar.empty-hint.no-note-off",
            "With experimental features off, the empty Connections card says nothing about "
            "them (#5954)",
            expect="the empty card: 'No connections yet', one sentence and 'New connection'; "
            "no 'Workflows are still experimental' line and no 'Turn on in Settings'",
        ):
            self._grade_card("connections-empty-off")

    def test_20_no_note_with_experimental_on(self):
        self._set_experimental(True)
        try:
            with self.step(
                "sidebar.empty-hint.no-note-on",
                "With experimental features on, the empty Connections card is unchanged (#5954)",
                expect="the same empty card, with no experimental note",
            ):
                self._grade_card("connections-empty-on")
        finally:
            self._set_experimental(False)
