"""Product run: the empty Connections sidebar's experimental signpost (#5873).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review (R-098, from #5858) saw
the signpost render "Settings ▸ General ▸ Allow experimental features" as one
inline link that wrapped into several underlined fragments in a narrow
sidebar. It is now one short sentence and one "Turn on in Settings" button.

The grade turns experimental features off, shrinks the window to its 800x600
minimum and the sidebar to its narrowest width, and measures the signpost: the
sentence wraps onto at most two lines and the one button is not clipped. It
then clicks the button and checks Settings ▸ General opens.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from termihub_harness import SettingsUi, SidebarUi, SystemTest, TabsUi
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.sidebar_empty_hint import (
    ACTION,
    ACTION_LABEL,
    HINT,
    HINT_TEXT,
    empty_hint_layout_problems,
    measure_empty_hint,
)

TOGGLE = "settings-experimental-features"
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
    hint_text: Optional[str] = None,
) -> dict[str, Any]:
    if buttons is None:
        buttons = [
            {
                "testId": ACTION,
                "text": ACTION_LABEL,
                "rect": _box(20, 140, 120, 24),
                "visible": True,
                "overflows": False,
            }
        ]
    return {
        "sidebar": _box(48, 0, 200, 560),
        "hint": {
            "text": hint_text if hint_text is not None else HINT_TEXT + ACTION_LABEL,
            "items": buttons,
        },
        "text": {
            "text": HINT_TEXT,
            "rect": _box(20, 100, 160, text_height),
            "lineHeight": LINE,
        },
    }


def test_grade_sentence_and_one_button_pass():
    assert empty_hint_layout_problems(_good()) == []
    assert empty_hint_layout_problems(_good(text_height=LINE)) == []


def test_grade_sentence_wrapping_onto_three_lines_fails():
    problems = empty_hint_layout_problems(_good(text_height=LINE * 3))
    assert "the sentence wraps onto 3 lines" in problems
    assert "the signpost spans 4 lines" in problems


def test_grade_old_inline_path_fails():
    old = "Workflows are behind Settings ▸ General ▸ Allow experimental features"
    problems = empty_hint_layout_problems(_good(hint_text=old, buttons=[]))
    assert any("spells out the settings path" in p for p in problems)
    assert "the signpost has 0 buttons, not one" in problems


def test_grade_two_buttons_fail():
    m = _good()
    m["hint"]["items"] = m["hint"]["items"] * 2
    assert empty_hint_layout_problems(m) == ["the signpost has 2 buttons, not one"]


def test_grade_clipped_or_overflowing_button_fails():
    m = _good()
    m["hint"]["items"][0]["overflows"] = True
    m["hint"]["items"][0]["rect"] = _box(20, 140, 260, 24)
    problems = empty_hint_layout_problems(m)
    assert "the button's label is clipped" in problems
    assert "the button runs outside the sidebar" in problems


def test_grade_wrong_label_fails():
    m = _good()
    m["hint"]["items"][0]["text"] = "Settings ▸ General ▸ Allow experimental features"
    problems = empty_hint_layout_problems(m)
    assert any("the button reads" in p for p in problems)


def test_grade_missing_signpost_fails():
    m = {"sidebar": _box(48, 0, 200, 560), "hint": None}
    assert empty_hint_layout_problems(m) == [
        "no experimental signpost on the empty Connections sidebar"
    ]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunSidebarEmptyHint(ProductRunUi, SettingsUi, SidebarUi, TabsUi, SystemTest):
    phase = "Empty sidebar signpost"
    request_timeout = 60.0

    state: dict[str, Any] = {}

    def reset_before_rerun(self) -> None:
        self._restore_layout()

    def _set_experimental_off(self) -> None:
        if not self._experimental_enabled():
            return
        self.open_settings_category("general")
        self.wait(lambda: self.driver.exists(TOGGLE), what="the experimental-features toggle")
        self.driver.click(TOGGLE)
        self.wait(lambda: not self._experimental_enabled(), what="experimental features off")
        self.close_all_tabs()

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

    def test_10_signpost_in_narrow_sidebar(self):
        self._set_experimental_off()
        self.switch_to_connections_sidebar()
        if not self.driver.exists(HINT):
            pytest.skip("the run already has saved connections; no empty-state signpost")
        with self.step(
            "sidebar.empty-hint.narrow",
            "In the narrowest sidebar the empty Connections signpost is one short sentence "
            "and one button (#5873)",
            expect="the 200px sidebar's empty card: 'New connection', under it the small "
            "line 'Workflows are still experimental.' and one 'Turn on in Settings' button; "
            "no underlined fragments, nothing cut off",
        ):
            self._narrow_layout()
            try:
                m = measure_empty_hint(self.driver)
                self.shot(label="narrow-signpost")
                self.evidence(
                    f"sidebar {m['sidebar']}; hint {(m['hint'] or {}).get('text')!r}; "
                    f"sentence {(m.get('text') or {}).get('rect')}"
                )
                problems = empty_hint_layout_problems(m)
                assert not problems, problems
            finally:
                self._restore_layout()

    def test_20_button_opens_general_settings(self):
        self._set_experimental_off()
        self.switch_to_connections_sidebar()
        if not self.driver.exists(ACTION):
            pytest.skip("the run already has saved connections; no empty-state signpost")
        with self.step(
            "sidebar.empty-hint.opens-settings",
            "The signpost's button opens Settings ▸ General (#5873)",
            expect="the Settings tab on General, with 'Allow experimental features' in view",
        ):
            self.driver.click(ACTION)
            self.wait(lambda: self.driver.exists(TOGGLE), what="Settings ▸ General")
            self.shot(label="general-settings")
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
