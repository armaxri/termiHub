"""Network Tools sidebar + diagnostic-panel helpers (issue #831, port #810).

``NetworkToolsUi`` opens the experimental Network Tools sidebar and its tool
panels (ping, port scanner, DNS, open ports, traceroute, Wake-on-LAN, HTTP
monitor). It builds on :class:`~termihub_harness.ui.SettingsUi` (the sidebar is
gated behind experimental features) and :class:`~termihub_harness.ui.SidebarUi`
(to switch the activity-bar view), so suites combine all three alongside
:class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

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

    # ── live diagnostic flows (issue #946) ──────────────────────────────────────
    # Each opens the tool's panel, fills its input(s), and triggers the run. The
    # ``type`` bridge verb replaces the field value, so no clearing is needed.
    # Results are DOM-only (component state fed by Tauri events), so callers
    # assert on rendered rows/text rather than the store.

    def start_ping(self, host: str) -> None:
        """Open the Ping panel, target ``host``, and start pinging."""
        self.open_tool_panel("ping", "ping-panel")
        self.driver.type("ping-host", host)
        self.driver.click("ping-start")

    def stop_ping(self) -> None:
        """Stop a running ping, if the Stop button is present."""
        if self.driver.exists("ping-stop"):
            self.driver.click("ping-stop")

    def run_port_scan(self, host: str, ports: str) -> None:
        """Open the Port Scanner panel and scan ``ports`` (e.g. ``"80,8080"``) on ``host``."""
        self.open_tool_panel("port-scanner", "port-scanner-panel")
        self.driver.type("port-scanner-host", host)
        self.driver.type("port-scanner-ports", ports)
        self.driver.click("port-scanner-run")

    def run_dns_lookup(
        self,
        hostname: str,
        *,
        record_type: Optional[str] = None,
        server: Optional[str] = None,
    ) -> None:
        """Open the DNS Lookup panel and resolve ``hostname``.

        ``record_type`` (``"MX"``, ``"TXT"``, …) picks the Type dropdown;
        ``server`` fills the custom resolver field — a bare IP or an ``ip:port``
        such as a :class:`~termihub_harness.StubDnsServer` address (#3692).
        """
        self.open_tool_panel("dns-lookup", "dns-lookup-panel")
        self.driver.type("dns-hostname", hostname)
        if record_type is not None:
            self.driver.select("dns-record-type", record_type)
        if server is not None:
            self.driver.type("dns-server", server)
        self.driver.click("dns-run")

    # ── run location ("Run on", #2191 / #3692) ──────────────────────────────────

    def _try_select_run_location(self, tool: str, value: str) -> bool:
        self.driver.select(f"network-runloc-{tool}", value)
        return True

    def set_tool_run_location(self, tool: str, agent_id: Optional[str]) -> None:
        """Set the open ``tool`` panel's "Run on" selector.

        ``agent_id`` picks that agent (option value ``agent:<id>``); ``None``
        picks This computer. The agent option appears only once the agent is in
        the projected agent list, so the select is retried until it exists.
        """
        value = "this" if agent_id is None else f"agent:{agent_id}"
        self.wait(
            lambda: self._try_select_run_location(tool, value),
            what=f"the {tool!r} Run-on option {value!r}",
        )

    def refresh_open_ports(self) -> str:
        """Open the Open Ports panel, click Refresh, and return the panel text
        once the "N listening port(s)" footer reflects the completed run."""
        self.open_tool_panel("open-ports", "open-ports-panel")
        self.wait(
            lambda: not self.driver.exists("open-ports-refresh")
            or "Refreshing" not in (self.driver.get_text("open-ports-refresh") or ""),
            what="any in-flight open-ports listing to finish",
        )
        self.driver.click("open-ports-refresh")
        self.wait(
            lambda: "Refreshing" not in (self.driver.get_text("open-ports-refresh") or "")
            and "listening port(s)" in (self.driver.get_text("open-ports-panel") or ""),
            what="the open-ports listing to complete",
        )
        return self.driver.get_text("open-ports-panel") or ""

    def start_http_monitor(self, url: str, *, allow_private_network: bool = False) -> None:
        """Open the HTTP Monitor panel, target ``url``, and start monitoring.

        ``allow_private_network`` ticks the panel's "Private network" opt-in: the
        SSRF guard (SEC-008) refuses loopback/private targets without it, so a
        suite monitoring its local fixture server must pass ``True`` (#4017).
        """
        self.open_http_monitor()
        self.driver.type("http-monitor-url", url)
        if allow_private_network:
            self.driver.click("http-monitor-allow-private")
            self.wait(
                lambda: self.driver.get_attribute("http-monitor-allow-private", "aria-checked")
                == "true",
                what="the private-network opt-in to be checked",
            )
        self.driver.click("http-monitor-start")

    def stop_http_monitor(self) -> None:
        """Stop a running HTTP monitor, if the Stop button is present."""
        if self.driver.exists("http-monitor-stop"):
            self.driver.click("http-monitor-stop")
