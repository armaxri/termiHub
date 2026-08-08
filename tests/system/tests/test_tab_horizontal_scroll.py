"""Per-tab horizontal-scroll toggle and its default.

Ported from ``tests/e2e/tab-horizontal-scroll.test.js`` onto the Python bridge
harness (#808). The feature's state is asserted through ``settings`` and
``tabHorizontalScrolling`` rather than the xterm canvas.

Not ported (kept as manual tests in docs/testing.md): the drag-to-select,
mouse-wheel horizontal scroll, and window-resize scroll-area checks operate on
the xterm GPU canvas / OS window, which the in-webview bridge cannot drive.
"""

import pytest

from termihub_harness import SETTINGS_REGION, SystemTest, TabsUi, TerminalUi

pytestmark = pytest.mark.integration

CTX_HSCROLL = "tab-context-horizontal-scroll"


class TestTabHorizontalScroll(TerminalUi, TabsUi, SystemTest):
    def _hscroll(self, tab_id: str):
        return (self.driver.get_state("tabHorizontalScrolling") or {}).get(tab_id)

    def test_horizontal_scrolling_is_off_by_default(self):
        settings = self.projection_region_cache(SETTINGS_REGION)
        assert not settings.get("defaultHorizontalScrolling", False)

    def test_toggle_horizontal_scrolling_via_tab_context_menu(self):
        self.close_all_tabs()
        self.ensure_terminal()
        tab = self.tab_ids()[0]
        assert not self._hscroll(tab)

        self.driver.context_menu(f"tab-{tab}")
        self.wait(lambda: self.driver.exists(CTX_HSCROLL), what="the tab context menu")
        self.driver.click(CTX_HSCROLL)
        self.wait(lambda: self._hscroll(tab) is True, what="horizontal scrolling on")
        self.delay4user(2, reason="horizontal scrolling enabled")

        self.driver.context_menu(f"tab-{tab}")
        self.wait(lambda: self.driver.exists(CTX_HSCROLL), what="the tab context menu again")
        self.driver.click(CTX_HSCROLL)
        self.wait(lambda: not self._hscroll(tab), what="horizontal scrolling off")
