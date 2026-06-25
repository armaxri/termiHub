"""Terminal auto-scroll: respect the user's scroll position (#504).

Ported from ``tests/e2e/terminal-auto-scroll.test.js`` onto the Python bridge
harness (#809). The original drove xterm with synthetic mouse-wheel gestures and
read ``buffer.active.viewportY/baseY`` through ``browser.execute`` — neither of
which the bridge offered. This port uses two bridge verbs added for it:

- ``scroll_terminal(lines, to_bottom=…)`` — routes through xterm's own
  ``scrollLines``/``scrollToBottom``, firing the same ``onScroll`` a wheel gesture
  would, so the auto-scroll guard observes the user's scroll exactly as in
  production.
- ``terminal_viewport()`` — reads ``{viewportY, baseY}`` so the test asserts the
  viewport position without scraping the GPU canvas.

``viewportY < baseY`` means scrolled up into the scrollback (auto-scroll
suppressed); ``viewportY == baseY`` means pinned to the bottom.
"""

import pytest

from termihub_harness import SystemTest, TerminalUi

pytestmark = pytest.mark.integration


class TestTerminalAutoScroll(TerminalUi, SystemTest):
    def _fresh_bottom_terminal(self) -> None:
        """Ensure one terminal exists and is pinned to the bottom.

        The suite shares one terminal across its two tests; resetting to the
        bottom (rather than closing every tab, which would null the active panel)
        gives each test a clean, auto-scrolling starting point.
        """
        self.ensure_terminal()
        self.driver.scroll_terminal(0, to_bottom=True)

    def _fill_scrollback(self, lo: int, hi: int) -> None:
        """Emit ``seq lo hi`` and wait until the last number has rendered."""
        self.run_command(f"seq {lo} {hi}")
        self.wait_for_output(str(hi))

    # ── MT-SCROLL-01: auto-scroll preserves the user's position ─────────────
    def test_output_does_not_yank_the_view_when_scrolled_up(self):
        self._fresh_bottom_terminal()
        self._fill_scrollback(1, 500)

        # Scroll up into the scrollback; the viewport must leave the bottom.
        self.driver.scroll_terminal(-100)
        scrolled = self.wait(
            lambda: (lambda v: v if v["viewportY"] < v["baseY"] else None)(
                self.driver.terminal_viewport()
            ),
            what="the viewport to scroll up",
        )
        saved_viewport_y = scrolled["viewportY"]

        # More output arrives while scrolled up — the view must stay put.
        self._fill_scrollback(501, 600)
        after = self.driver.terminal_viewport()
        assert after["viewportY"] < after["baseY"], "auto-scroll yanked the view to the bottom"
        # The retained lines don't move (scrollback isn't trimmed at this size).
        assert abs(after["viewportY"] - saved_viewport_y) <= 2

    # ── MT-SCROLL-02: auto-scroll resumes after returning to the bottom ─────
    def test_auto_scroll_resumes_after_scrolling_back_to_bottom(self):
        self._fresh_bottom_terminal()
        self._fill_scrollback(1, 500)

        # Scroll up, then jump back to the bottom (re-arming auto-scroll).
        self.driver.scroll_terminal(-100)
        self.wait(
            lambda: self.driver.terminal_viewport()["viewportY"]
            < self.driver.terminal_viewport()["baseY"],
            what="the viewport to scroll up",
        )
        self.driver.scroll_terminal(0, to_bottom=True)

        # New output should now stick to the bottom again.
        self._fill_scrollback(601, 700)
        at_bottom = self.wait(
            lambda: (lambda v: v if v["viewportY"] >= v["baseY"] - 2 else None)(
                self.driver.terminal_viewport()
            ),
            what="auto-scroll to pin the view to the bottom",
        )
        assert at_bottom["viewportY"] >= at_bottom["baseY"] - 2
