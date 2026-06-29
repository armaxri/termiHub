"""Network Tools sidebar + diagnostic-panel helpers (issue #831, port #810).

``NetworkToolsUi`` opens the experimental Network Tools sidebar and its tool
panels (ping, port scanner, DNS, open ports, traceroute, Wake-on-LAN, HTTP
monitor). It builds on :class:`~termihub_harness.ui.SettingsUi` (the sidebar is
gated behind experimental features) and :class:`~termihub_harness.ui.SidebarUi`
(to switch the activity-bar view), so suites combine all three alongside
:class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import HarnessMixin


class NetworkToolsUi(HarnessMixin):
    """Open the Network Tools sidebar and its diagnostic tool panels."""

    if TYPE_CHECKING:  # borrowed from the mixins suites combine this with
        def enable_experimental_features(self) -> None: ...
        def _ensure_sidebar(self, view: str, test_id: str) -> None: ...

    def open_network_tools_sidebar(self) -> None:
        """Reveal and show the Network Tools sidebar (idempotent)."""
        self.enable_experimental_features()
        self._ensure_sidebar("network-tools", "activity-bar-network-tools")
        self.wait(
            lambda: self.driver.exists("network-tools-sidebar"),
            what="the Network Tools sidebar",
        )

    def open_tool_panel(self, tool: str, panel_testid: str) -> None:
        """Click a sidebar quick-action (``ping``, ``dns-lookup``, …) and wait
        for its panel to render in a split-view tab."""
        self.open_network_tools_sidebar()
        self.driver.click(f"network-quick-action-{tool}")
        self.wait(lambda: self.driver.exists(panel_testid), what=f"the {tool} panel")

    def open_http_monitor(self) -> None:
        """Open the HTTP-monitor panel via the sidebar's New Monitor button."""
        self.open_network_tools_sidebar()
        self.driver.click("network-new-monitor")
        self.wait(
            lambda: self.driver.exists("http-monitor-panel"),
            what="the HTTP monitor panel",
        )
