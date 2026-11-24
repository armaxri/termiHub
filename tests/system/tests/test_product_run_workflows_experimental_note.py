"""Product run: the Workflows view's experimental note (#5954).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review (round 2, run
``20261124T122947Z``) found "Workflows are still experimental. Turn on in
Settings." at the end of the empty Connections card: it read as if connections
needed an experimental switch, and the action read as plain text. The note now
lives only in the Workflows view, while the switch is off, with a secondary
"Turn on in Settings" button that opens Settings ▸ General.

The grade opens the Workflows view with experimental features on, turns them
off (the view stays open), shrinks the window to its 800x600 minimum and the
sidebar to its narrowest width, and measures the note: the sentence wraps onto
at most two lines and the one secondary button is not clipped. It then clicks
the button and checks Settings ▸ General opens.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from termihub_harness import SettingsUi, SidebarUi, SystemTest, TabsUi
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.sidebar_empty_hint import (
    ACTION_LABEL,
    NOTE,
    NOTE_ACTION,
    NOTE_TEXT,
    SECONDARY_CLASS,
    workflows_note_layout_problems,
    measure_workflows_note,
)

TOGGLE = "settings-experimental-features"
WORKFLOWS_ITEM = "activity-bar-workflows"
#: The minimum supported window.
NARROW_WINDOW = (800, 600)
#: The product run's normal window, restored afterwards.
NORMAL_WINDOW = (1280, 800)
#: ``SIDEBAR_MIN_WIDTH`` in ``src/hooks/useSidebarResize.ts``.
SIDEBAR_MIN_WIDTH = 200
SIDEBAR_HANDLE = "sidebar-resize-handle"
LINE = 15.0


# ── app-free grade tests ──────────────────────────────────────────────────
def _box(x: float, y: float, width: float, height: float) -> dict[str, float]:
    return {"x": x, "y": y, "width": width, "height": height}


def _good(
    *,
    text_height: float = LINE * 2,
    buttons: Optional[list[dict[str, Any]]] = None,
    action_class: str = f"ui-btn {SECONDARY_CLASS} ui-btn--sm",
) -> dict[str, Any]:
    if buttons is None:
        buttons = [
            {
                "testId": NOTE_ACTION,
                "text": ACTION_LABEL,
                "rect": _box(56, 60, 140, 28),
                "visible": True,
                "overflows": False,
            }
        ]
    return {
        "sidebar": _box(48, 0, 200, 560),
        "note": {"text": NOTE_TEXT + ACTION_LABEL, "items": buttons},
        "text": {"text": NOTE_TEXT, "rect": _box(56, 20, 180, text_height), "lineHeight": LINE},
        "actionClass": action_class,
    }


def test_grade_sentence_and_one_secondary_button_pass():
    assert workflows_note_layout_problems(_good()) == []
    assert workflows_note_layout_problems(_good(text_height=LINE)) == []


def test_grade_sentence_wrapping_onto_three_lines_fails():
    problems = workflows_note_layout_problems(_good(text_height=LINE * 3))
    assert problems == ["the sentence wraps onto 3 lines"]


def test_grade_plain_text_action_fails():
    """The #5954 finding: an action that reads as text, not as a button."""
    problems = workflows_note_layout_problems(_good(action_class="ui-btn ui-btn--ghost"))
    assert problems == ["the action is not styled as a secondary button"]
    assert workflows_note_layout_problems(_good(buttons=[])) == ["the note has 0 buttons, not one"]


def test_grade_clipped_or_overflowing_button_fails():
    m = _good()
    m["note"]["items"][0]["overflows"] = True
    m["note"]["items"][0]["rect"] = _box(56, 60, 260, 28)
    problems = workflows_note_layout_problems(m)
    assert "the button's label is clipped" in problems
    assert "the button runs outside the sidebar" in problems


def test_grade_wrong_label_fails():
    m = _good()
    m["note"]["items"][0]["text"] = "Settings ▸ General ▸ Allow experimental features"
    assert any("the button reads" in p for p in workflows_note_layout_problems(m))


def test_grade_missing_note_fails():
    m = {"sidebar": _box(48, 0, 200, 560), "note": None}
    assert workflows_note_layout_problems(m) == ["no experimental note in the Workflows view"]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunWorkflowsExperimentalNote(
    ProductRunUi, SettingsUi, SidebarUi, TabsUi, SystemTest
):
    phase = "Workflows experimental note"
    request_timeout = 60.0

    state: dict[str, Any] = {}

    def reset_before_rerun(self) -> None:
        self._restore_layout()

    def _open_workflows_with_experimental_off(self) -> None:
        """Open the Workflows view, then turn the switch off; the view stays open."""
        if self.driver.get_state("sidebarView") != "workflows" or self._experimental_enabled():
            self.enable_experimental_features()
            self.wait(lambda: self.driver.exists(WORKFLOWS_ITEM), what="the Workflows item")
            self._ensure_sidebar("workflows", WORKFLOWS_ITEM)
            self.open_settings_category("general")
            self.wait(lambda: self.driver.exists(TOGGLE), what="the experimental-features toggle")
            self.driver.click(TOGGLE)
            self.wait(lambda: not self._experimental_enabled(), what="experimental features off")
            self.close_all_tabs()
        self.wait(lambda: self.driver.exists(NOTE), what="the Workflows experimental note")

    def _narrow_layout(self) -> None:
        self.state["sidebar_width"] = self.driver.get_state("sidebarWidth")
        self.driver.resize_window(*NARROW_WINDOW)
        self.driver.press_key("Home", SIDEBAR_HANDLE)
        self.wait(
            lambda: self.driver.get_state("sidebarWidth") == SIDEBAR_MIN_WIDTH,
            what="the sidebar at its narrowest width",
        )

    def _restore_layout(self) -> None:
        self.driver.resize_window(*NORMAL_WINDOW)
        width = self.state.pop("sidebar_width", None)
        current = self.driver.get_state("sidebarWidth")
        if isinstance(width, (int, float)) and isinstance(current, (int, float)):
            self.driver.drag(SIDEBAR_HANDLE, float(width) - float(current))

    def test_10_note_in_narrow_workflows_view(self):
        with self.step(
            "workflows.experimental-note.narrow",
            "With experimental features off, the Workflows view says so and offers one "
            "button to turn them on (#5954)",
            expect="the 200px Workflows sidebar: at the top a small line 'Workflows are "
            "still experimental and turned off.' and one bordered 'Turn on in Settings' "
            "button with a gear icon; nothing cut off",
        ):
            self._open_workflows_with_experimental_off()
            self._narrow_layout()
            try:
                m = measure_workflows_note(self.driver)
                self.shot(label="narrow-workflows-note")
                self.evidence(
                    f"sidebar {m['sidebar']}; note {(m['note'] or {}).get('text')!r}; "
                    f"sentence {(m.get('text') or {}).get('rect')}; class {m.get('actionClass')!r}"
                )
                problems = workflows_note_layout_problems(m)
                assert not problems, problems
            finally:
                self._restore_layout()

    def test_20_button_opens_general_settings(self):
        with self.step(
            "workflows.experimental-note.opens-settings",
            "The note's button opens Settings ▸ General (#5954)",
            expect="the Settings tab on General, with 'Allow experimental features' in view",
        ):
            self._open_workflows_with_experimental_off()
            self.driver.click(NOTE_ACTION)
            self.wait(lambda: self.driver.exists(TOGGLE), what="Settings ▸ General")
            self.shot(label="general-settings")
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
