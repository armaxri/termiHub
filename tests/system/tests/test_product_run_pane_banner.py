"""Product run: a pane's disconnect banner sits on top, clear of toasts (#5823).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` (R-003) saw the "Agent disconnected — press Enter or click
Reconnect …" banner cut off at the bottom of the terminal, with its Reconnect
button under a "Saved …" toast: the one recovery action on screen was covered.

The banner now sits at the top of the pane, full width, like the reconnect
strip; it reads a short heading ("Agent disconnected." / "Process exited (code
0)." — the strip's heading, #5955) and
a hint that wraps instead of clipping; it is a toast keep-clear zone. The grade
shrinks the window to the 800x600 minimum, ends a local shell, dismisses the
disconnect overlay into view mode, raises a toast (closing another exited tab
shows the "Closed …" · Reopen toast), grades the banner, and clicks Reconnect
with the toast still on screen. No servers needed. The agent variant shares the
component and its layout; only the heading differs.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

import sys
import time
from typing import Any

import pytest

from termihub_harness import (
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.pane_banner import pane_banner_problems

TOAST_REGION = "toast-region"
BANNER = "terminal-view-mode-banner"
RECONNECT = "terminal-view-mode-reconnect-btn"
#: The strip's one dismiss control (#5955: "View scrollback" is gone).
DISMISS = "terminal-disconnect-dismiss-btn"
#: The minimum supported window, where the old banner text was cut off.
NARROW_WINDOW = (800, 600)
#: The product run's normal window, restored afterwards.
NORMAL_WINDOW = (1280, 800)


# ── app-free grade tests ──────────────────────────────────────────────────
def _rect(x: float, y: float, w: float, h: float) -> dict[str, float]:
    return {"x": x, "y": y, "width": w, "height": h}


PANE = _rect(220, 70, 580, 500)
TOP_BANNER = _rect(220, 70, 580, 26)
BUTTON = {"rect": _rect(700, 72, 88, 22), "visible": True, "overflows": False}


def _grade(**overrides: Any) -> list[str]:
    args: dict[str, Any] = {
        "banner": TOP_BANNER,
        "banner_text": "Agent disconnected. Press Enter to reconnect. Reconnect",
        "pane": PANE,
        "reconnect": BUTTON,
        "text_items": [],
        "toasts": [],
        "viewport": NARROW_WINDOW,
    }
    args.update(overrides)
    return pane_banner_problems(**args)


def test_grade_top_banner_with_clear_toast_passes():
    toast = {"text": "Saved", "rect": _rect(444, 500, 340, 64), "visible": True}
    assert _grade(toasts=[toast]) == []
    assert _grade(banner_text="Session ended. Press Enter to reconnect.") == []
    # #5955: the banner keeps the strip's heading.
    assert _grade(banner_text="Session disconnected. Press Enter to reconnect.") == []
    assert _grade(banner_text="Process exited (code 0). Press Enter to restart.") == []


def test_grade_bottom_banner_fails():
    # The R-003 shape: pinned to the bottom edge of the pane.
    bottom = _rect(220, 544, 580, 26)
    button = {**BUTTON, "rect": _rect(700, 546, 88, 22)}
    problems = _grade(banner=bottom, reconnect=button)
    assert any("not at the pane top" in p for p in problems)


def test_grade_toast_over_reconnect_fails():
    toast = {"text": "Saved “web”", "rect": _rect(444, 60, 340, 64), "visible": True}
    assert any("covers Reconnect" in p for p in _grade(toasts=[toast]))
    over_text = {"text": "Saved", "rect": _rect(300, 80, 200, 40), "visible": True}
    assert any("covers the banner" in p for p in _grade(toasts=[over_text]))


def test_grade_clipped_or_long_copy_fails():
    clipped = [
        {
            "text": "Agent disconnected — press Enter or click…",
            "rect": _rect(240, 74, 400, 16),
            "visible": True,
            "overflows": True,
        }
    ]
    assert any("is clipped" in p for p in _grade(text_items=clipped))
    old = "Agent disconnected — press Enter or click Reconnect to reconnect it"
    assert any("does not start with" in p for p in _grade(banner_text=old))


def test_grade_missing_or_offscreen_reconnect_fails():
    assert any("no visible Reconnect" in p for p in _grade(reconnect=None))
    hidden = {**BUTTON, "visible": False}
    assert any("no visible Reconnect" in p for p in _grade(reconnect=hidden))
    off = {**BUTTON, "rect": _rect(790, 72, 88, 22)}
    problems = _grade(reconnect=off)
    assert any("sticks out of the banner" in p for p in problems)
    assert any("outside the 800x600 window" in p for p in problems)


def test_grade_narrow_banner_fails():
    narrow = _rect(220, 70, 400, 26)
    assert any("does not span the pane" in p for p in _grade(banner=narrow))


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the grade exits a POSIX shell")
class TestProductRunPaneBanner(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Pane banner"
    request_timeout = 90.0

    def reset_before_rerun(self) -> None:
        self.driver.resize_window(*NORMAL_WINDOW)

    def _shown(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            i for i in items if i["visible"] and i["rect"]["width"] > 2 and i["rect"]["height"] > 2
        ]

    def _toast_items(self) -> list[dict[str, Any]]:
        """The visible text and button items inside the toast stack."""
        if not self.driver.exists(TOAST_REGION):
            return []
        items: list[dict[str, Any]] = []
        for kind in ("text", "buttons"):
            items += self._shown(self.driver.measure_element(TOAST_REGION, kind)["items"])
        return items

    def _exited_connection_tab(self, name: str) -> str:
        """Open local connection ``name``, end its shell, and return the tab id."""
        before = self.tab_ids()
        self.create_local_connection(name, connect=True)
        tab = self.wait(
            lambda: next(
                (
                    t["id"]
                    for t in self._all_tabs()
                    if t["id"] not in before and t.get("title") == name
                ),
                None,
            ),
            what=f"the {name!r} terminal",
        )
        self.switch_to_tab(tab)
        self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
        self.run_command("exit")
        self.wait(lambda: self.terminal_session_exited(tab), what=f"the {name!r} shell to exit")
        return tab

    def test_10_banner_on_top_clear_of_toasts(self):
        with self.step(
            "terminal.view-mode-banner",
            "At 800x600 the 'Process exited (code 0).' banner sits at the top of the pane, "
            "uncut, and its Restart works with a toast on screen (#5823, #5955)",
            expect="an 800x600 window: a full-width 'Process exited (code 0). Press Enter to "
            "restart.' strip at the TOP of the terminal with a Restart button at its right end, no "
            "text cut off; a 'Closed …' · Reopen toast at the bottom right that covers "
            "neither the strip nor Reconnect",
        ):
            self.switch_to_connections_sidebar()
            self.driver.resize_window(*NARROW_WINDOW)
            try:
                other = self._exited_connection_tab(unique_name("pr-banner-b"))
                tab = self._exited_connection_tab(unique_name("pr-banner"))
                # A toast on screen: closing the other exited tab offers Reopen. Close
                # it first: its hidden pane carries the same end-strip test ids, and
                # the bridge clicks the first match in the DOM.
                self.close_tab(other)
                self.wait(lambda: self._toast_items() or None, timeout=5.0, what="a toast")
                self.wait(lambda: self.driver.exists(DISMISS), what="the end strip")
                self.driver.click(DISMISS)
                self.wait(lambda: self.driver.exists(BANNER), what="the view-mode banner")
                time.sleep(0.3)  # let the stack lay out around keep-clear zones
                banner = self.driver.measure_element(BANNER, "buttons")
                text = self.driver.measure_element(BANNER, "text")
                pane = self.driver.measure_element(f"terminal-context-trigger-{tab}")["rect"]
                buttons = self._shown(banner["items"])
                reconnect = next((b for b in buttons if b.get("testId") == RECONNECT), None)
                toasts = self._toast_items()
                self.shot(label="narrow")
                self.evidence(
                    f"window {NARROW_WINDOW}; pane {pane}; banner {banner['rect']} "
                    f"{banner['text']!r}; reconnect {reconnect and reconnect['rect']}; toasts "
                    f"{[(t['text'] or t.get('label'), t['rect']) for t in toasts]}"
                )
                problems = pane_banner_problems(
                    banner=banner["rect"],
                    banner_text=banner["text"],
                    pane=pane,
                    reconnect=reconnect,
                    text_items=text["items"],
                    toasts=toasts,
                    viewport=NARROW_WINDOW,
                )
                assert not problems, problems
                # The one recovery action works while the toast is still up.
                assert self._toast_items(), "the toast left before Reconnect could be graded"
                self.driver.click(RECONNECT)
                self.wait(
                    lambda: not self.driver.exists(BANNER)
                    and not self.terminal_session_exited(tab),
                    what="Reconnect to start a new session",
                )
                self.evidence("Reconnect started a new session with the toast on screen")
            finally:
                self.driver.resize_window(*NORMAL_WINDOW)
        self.close_all_tabs()
