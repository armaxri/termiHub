"""Network Tools panel UI (ported from network-tools.test.js, NT-01..09).

Drives the experimental Network Tools sidebar and each diagnostic tool's panel:
open the panel from a sidebar quick-action and assert its controls render and
are disabled while empty. These are the **portable** cases — they need no
network and assert on the live DOM (panel/control presence, the `disabled`
attribute) the bridge can read.

The cases needing real network I/O (live ping stats, port-scan results, DNS
resolution, HTTP-monitor checks) live in `network-tools-live.test.js` and are
**not** ported here — several reference `data-testid`s that don't yet exist on
the result rows/controls (tracked in #934).
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    NetworkToolsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
)

pytestmark = pytest.mark.integration


class TestNetworkTools(NetworkToolsUi, SidebarUi, SettingsUi, TabsUi, SystemTest):
    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # ── NT-01: sidebar ──────────────────────────────────────────────────────────
    def test_sidebar_shows_all_quick_actions(self):
        """NT-01: the sidebar lists every quick action, the Local section's
        actions, and the New Monitor button."""
        self.open_network_tools_sidebar()
        assert self.driver.exists("network-tools-sidebar")
        for tool in ("ping", "port-scanner", "dns-lookup", "wol", "open-ports", "traceroute"):
            assert self.driver.exists(f"network-quick-action-{tool}"), tool
        assert self.driver.exists("network-new-monitor")

    # ── NT-02..07: each tool panel opens with its controls ──────────────────────
    def test_ping_panel_opens_with_controls(self):
        """NT-02: Ping panel — host input + Start, disabled while host empty."""
        self.open_tool_panel("ping", "ping-panel")
        assert self.driver.exists("ping-host")
        assert self.driver.exists("ping-start")
        assert self.is_disabled("ping-start")

    def test_port_scanner_panel_opens_with_controls(self):
        """NT-03: Port Scanner — host/ports inputs + Run, disabled while empty."""
        self.open_tool_panel("port-scanner", "port-scanner-panel")
        assert self.driver.exists("port-scanner-host")
        assert self.driver.exists("port-scanner-ports")
        assert self.driver.exists("port-scanner-run")
        assert self.is_disabled("port-scanner-run")

    def test_dns_lookup_panel_opens_with_controls(self):
        """NT-04: DNS Lookup — hostname input + Run button."""
        self.open_tool_panel("dns-lookup", "dns-lookup-panel")
        assert self.driver.exists("dns-hostname")
        assert self.driver.exists("dns-run")

    def test_traceroute_panel_opens_with_controls(self):
        """NT-06: Traceroute — host input + Run, disabled while host empty."""
        self.open_tool_panel("traceroute", "traceroute-panel")
        assert self.driver.exists("traceroute-host")
        assert self.driver.exists("traceroute-run")
        assert self.is_disabled("traceroute-run")

    def test_wol_panel_opens_with_controls(self):
        """NT-07: Wake-on-LAN — MAC input + Send, disabled while MAC empty."""
        self.open_tool_panel("wol", "wol-panel")
        assert self.driver.exists("wol-mac")
        assert self.driver.exists("wol-send")
        assert self.is_disabled("wol-send")

    def test_http_monitor_panel_opens_with_controls(self):
        """NT-08: HTTP Monitor (via New Monitor) — URL input + Start button."""
        self.open_http_monitor()
        assert self.driver.exists("http-monitor-url")
        assert self.driver.exists("http-monitor-start")

    # ── NT-05: open ports responds to a local query ─────────────────────────────
    def test_open_ports_refresh_returns_a_result(self):
        """NT-05: the Open Ports panel opens, and Refresh (a local query)
        replaces the idle placeholder with a result or an error."""
        self.open_tool_panel("open-ports", "open-ports-panel")
        assert self.driver.exists("open-ports-refresh")
        self.wait(
            lambda: "Click Refresh" in self.driver.get_text("open-ports-panel"),
            what="the idle Open Ports placeholder",
        )
        self.driver.click("open-ports-refresh")
        # The placeholder only shows while idle+empty; once the backend responds
        # (results table or error) it is gone — either outcome means it answered.
        self.wait(
            lambda: "Click Refresh" not in self.driver.get_text("open-ports-panel"),
            what="Open Ports to return a result or error",
        )

    # ── NT-09: multiple diagnostic tabs coexist ─────────────────────────────────
    def test_multiple_panels_open_simultaneously(self):
        """NT-09: each tool opens its own tab — opening a second tool doesn't
        close the first. (Only the active tab's panel is mounted, so coexistence
        is asserted on the tabs, not on both panels being in the DOM.)"""
        self.open_tool_panel("ping", "ping-panel")
        self.open_network_tools_sidebar()
        self.driver.click("network-quick-action-dns-lookup")
        self.wait(lambda: self.driver.exists("dns-lookup-panel"), what="the DNS panel")
        assert self.find_tab("Ping") is not None
        assert self.find_tab("DNS Lookup") is not None
