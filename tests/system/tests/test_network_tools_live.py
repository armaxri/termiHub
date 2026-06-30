"""Network Tools — live diagnostic cases (ported from ``network-tools-live.test.js``, #946).

These drive the diagnostic tools with **real network I/O** and assert on the
results that stream back. Diagnostic results are DOM-only (component-local state
fed by Tauri events, not the Zustand store), so the checks read rendered rows /
panel text via the bridge rather than ``getState`` — using the result-row and
control ``data-testid``s added in #934.

Targets are kept local and deterministic, with no dependency on the Docker
``network`` profile (following the embedded-services live-test precedent #947/#964):

* **ping** / **DNS** run against loopback (``127.0.0.1`` / ``localhost``),
* **port scan** runs against a throwaway TCP listener this module opens on a free
  port, and
* **HTTP monitor** runs against a stdlib ``http.server`` this module starts on a
  free port (returns 200).

Covers MT-NET-10 (ping stats + chart), MT-NET-12 (port-scan results + footer),
MT-NET-14 (DNS A-record), MT-NET-17 (HTTP-monitor check + chart), MT-NET-18
(sidebar Monitors row).

**MT-NET-13 (large-range warning) is intentionally not ported**: that warning is
a native ``window.confirm()`` (``PortScannerPanel.tsx``), which carries no
``data-testid`` and cannot be driven from the in-webview bridge — it stays a
manual carve-out, as the issue allows.
"""

from __future__ import annotations

import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator

import pytest

from termihub_harness import (
    NetworkToolsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
)

pytestmark = pytest.mark.integration

# The monitor's default interval is 30s and it does an immediate first check on
# start. If the panel's event listener attaches a hair after that immediate check
# fires, the first result is missed and the next is one interval later — so the
# wait must comfortably outlast one 30s interval to be race-free.
FIRST_CHECK_TIMEOUT = 45.0


@pytest.fixture
def open_tcp_port() -> Iterator[int]:
    """A free localhost TCP port with a listening socket — scans as *open*.

    A bare ``listen`` (no ``accept``) is enough for a connect-scan to report the
    port open; the socket stays bound for the test's lifetime.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    try:
        yield sock.getsockname()[1]
    finally:
        sock.close()


@pytest.fixture
def http_target() -> Iterator[int]:
    """A free localhost HTTP server returning ``200 OK`` — the monitor's target."""

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (stdlib naming)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *_args):  # silence per-request stderr logging
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


class TestNetworkToolsLive(NetworkToolsUi, SidebarUi, SettingsUi, TabsUi, SystemTest):
    """One app; each test opens a diagnostic panel, runs it, and asserts results."""

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        # Stop anything still running, then clear the tab slate for the next test.
        self.stop_ping()
        self.stop_http_monitor()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # ── MT-NET-10: Ping — live stats + latency chart ────────────────────────────
    def test_ping_streams_stats_and_chart(self):
        self.start_ping("127.0.0.1")

        # While running, replies stream in (the panel shows "N replies received…")
        # and the latency chart renders once results begin.
        self.wait(
            lambda: re.search(r"[1-9]\d*\s+repl", self.driver.get_text("ping-stats") or ""),
            what="ping replies to stream in",
        )
        self.wait(lambda: self.driver.exists("ping-chart"), what="the ping latency chart")

        # Stopping finalizes the summary stats (Sent / Received / loss).
        self.stop_ping()
        self.wait(
            lambda: re.search(r"Sent:\s*[1-9]", self.driver.get_text("ping-stats") or ""),
            what="the final ping stats summary",
        )

    # ── MT-NET-12: Port Scanner — results stream in, footer on completion ───────
    def test_port_scan_finds_open_port(self, open_tcp_port: int):
        self.run_port_scan("127.0.0.1", f"{open_tcp_port},1")

        # At least one result row arrives, and the footer marks the scan complete.
        self.wait(lambda: self.driver.exists("port-scanner-result-0"), what="a port-scan result row")
        self.wait(lambda: self.driver.exists("port-scanner-footer"), what="the port-scan footer")

        # The open listener's port is reported open.
        panel = self.driver.get_text("port-scanner-panel") or ""
        assert "open" in panel.lower()
        assert str(open_tcp_port) in panel

    # ── MT-NET-14: DNS Lookup — A-record resolution ─────────────────────────────
    def test_dns_resolves_localhost(self):
        self.run_dns_lookup("localhost")

        self.wait(lambda: self.driver.exists("dns-result-0"), what="a DNS result row")
        assert "127.0.0.1" in (self.driver.get_text("dns-lookup-panel") or "")

    # ── MT-NET-17: HTTP Monitor — periodic check + response-time chart ──────────
    def test_http_monitor_check_and_chart(self, http_target: int):
        self.start_http_monitor(f"http://127.0.0.1:{http_target}")

        # The first check completes and records a 200 in the history table.
        self.wait(
            lambda: self.driver.exists("http-monitor-entry-0"),
            what="the first HTTP monitor check",
            timeout=FIRST_CHECK_TIMEOUT,
        )
        assert "200" in (self.driver.get_text("http-monitor-history") or "")
        # The response-time chart renders after the first check.
        self.wait(lambda: self.driver.exists("http-monitor-chart"), what="the response-time chart")
        self.stop_http_monitor()

    # ── MT-NET-18: HTTP Monitor — running monitor shows in the sidebar ──────────
    def test_http_monitor_shows_in_sidebar(self, http_target: int):
        self.start_http_monitor(f"http://127.0.0.1:{http_target}")
        self.wait(
            lambda: self.driver.exists("http-monitor-entry-0"),
            what="the first HTTP monitor check",
            timeout=FIRST_CHECK_TIMEOUT,
        )

        # The sidebar was already open when the monitor started; since #986 it
        # live-updates from the check event, so the running monitor appears
        # without a remount. Its row is keyed by a dynamic id, so assert on the
        # section's rendered short URL (host:port).
        self.wait(
            lambda: str(http_target) in (self.driver.get_text("network-monitors-section") or ""),
            what="the running monitor in the sidebar Monitors section",
        )
        self.stop_http_monitor()
