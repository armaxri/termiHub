"""SSH monitoring system tests (ported from infrastructure/ssh-monitoring.test.js).

Covers monitoring auto-connect, the status-bar stats/refresh/disconnect controls,
and hide-on-non-SSH behavior. Monitoring opens its own SSH session for stats, so
these require the ssh-password container (2201).
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    MonitoringUi,
    PasswordPromptUi,
    SSH_KEYS_PORT,
    SSH_KEY_PATH,
    SSH_USERNAME,
    SettingsUi,
    SidebarUi,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"

#: Projection region of the monitoring domain (twin of the frontend
#: ``SYSTEM_MONITORS_REGION`` in ``src/store/systemMonitorBridge.ts``). The monitor
#: state is region-authoritative since #2224: the old ``appStore`` monitoring
#: singleton (and its ``monitoringSessionId``) is gone, and each monitor lives at
#: ``monitors[<terminal session id>]``.
SYSTEM_MONITORS_REGION = "system-monitors"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshMonitoring(TerminalUi, TabsUi, SidebarUi, ConnectionsUi, PasswordPromptUi, SshUi, MonitoringUi, SettingsUi, SystemTest):
    # ── Auto-connect ──────────────────────────────────────────────────────────
    def test_auto_shows_stats_on_ssh_tab(self):
        self.connect_ssh_password(unique_name("ssh-mon-auto"))
        self.wait_for_monitoring_stats()

    def test_monitoring_follows_active_ssh_tab(self):
        # Two different SSH hosts; monitoring tracks whichever tab is active.
        name1 = unique_name("ssh-mon-h1")
        self.connect_ssh_password(name1)
        self.wait_for_monitoring_stats()

        name2 = unique_name("ssh-mon-h2")
        self.switch_to_connections_sidebar()
        self.create_ssh_connection(
            name2,
            host=HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=True,
        )
        # A different host (port) than the first tab: its key is not trusted yet,
        # so the handshake blocks on the #1959 trust prompt until accepted.
        self.accept_host_key_prompt()
        self.wait(self.has_terminal, what="the second SSH terminal")
        self.wait_for_monitoring_stats()

        tab1 = self.find_tab(name1)
        assert tab1 is not None
        self.switch_to_tab(tab1["id"])
        assert self.wait(
            self.monitoring_visible, what="monitoring back on the first tab"
        )

    def test_disconnect_triggers_reconnect(self):
        # On an SSH tab monitoring auto-connects, so a manual Disconnect is
        # immediately followed by an auto-reconnect with a *fresh* session — the
        # deterministic, observable proof that the Disconnect control fired.
        # (The original "stays disconnected" / "returns to Monitor button"
        # assertions are not portable: auto-connect never lets that state settle.)
        #
        # The monitor is keyed by the terminal session id, so a reconnect keeps
        # its key (and its `monitorSessionId`, which equals the key). What marks
        # the fresh session is its sample counter: every (re)connect restarts
        # `sampleCount` at 0 (`SystemMonitorStore::open`). So let a few samples
        # accumulate, disconnect, and wait for the count to drop below that mark.
        name = unique_name("ssh-mon-disc")
        self.connect_ssh_password(name)
        self.wait_for_monitoring_stats()
        # Earlier tests in this class leave their SSH tabs (and monitors) open,
        # so read this tab's monitor by its key: the terminal session id.
        key = self.wait(
            lambda: (self.find_tab(name) or {}).get("sessionId"),
            what="the SSH tab's session id",
        )
        before = self.wait(
            lambda: (lambda n: n if n is not None and n >= 3 else None)(self._sample_count(key)),
            timeout=30.0,
            what="the monitor to collect a few samples",
        )
        self.monitoring_disconnect()
        self.wait(
            lambda: (lambda n: n is None or n < before)(self._sample_count(key)),
            timeout=30.0,
            what="monitoring to drop the old session",
        )
        self.wait(
            lambda: self._live_monitor(key) is not None,
            timeout=30.0,
            what="monitoring to reconnect with a new session",
        )

    def _live_monitor(self, key: str):
        """The monitor entry for ``key`` once it is live (has a backend session)."""
        monitors = self.projection_region_cache(SYSTEM_MONITORS_REGION).get("monitors")
        entry = monitors.get(key) if isinstance(monitors, dict) else None
        return entry if isinstance(entry, dict) and entry.get("monitorSessionId") else None

    def _sample_count(self, key: str):
        """``sampleCount`` of the live monitor for ``key``, or ``None`` while not live."""
        monitor = self._live_monitor(key)
        return monitor.get("sampleCount") if monitor is not None else None

    # ── Status bar ────────────────────────────────────────────────────────────
    def test_displays_cpu_mem_disk(self):
        self.connect_ssh_password(unique_name("ssh-mon-stats"))
        stats = self.wait_for_monitoring_stats()
        assert stats["cpu"] and stats["mem"] and stats["disk"]

    def test_auto_refresh_keeps_stats(self):
        # Prove a refresh actually happened: the monitor's sample counter must
        # advance past the value seen once the first stats render. Stats that
        # merely stay on screen pass even when auto-refresh is broken (#4339).
        name = unique_name("ssh-mon-refresh")
        self.connect_ssh_password(name)
        self.wait_for_monitoring_stats()
        key = self.wait(
            lambda: (self.find_tab(name) or {}).get("sessionId"),
            what="the SSH tab's session id",
        )
        first = self.wait(
            lambda: self._sample_count(key),
            what="the monitor's first sample count",
        )
        self.wait(
            lambda: (self._sample_count(key) or 0) > first,
            timeout=20.0,
            what="a second monitoring sample (auto-refresh)",
        )
        assert self.monitoring_stats() is not None

    def test_dropdown_has_disconnect(self):
        self.connect_ssh_password(unique_name("ssh-mon-dropdown"))
        self.wait_for_monitoring_stats()
        self.open_monitoring_dropdown()
        assert self.driver.exists("monitoring-disconnect")

    # ── Hide on non-SSH tab ───────────────────────────────────────────────────
    def test_hides_on_settings_tab(self):
        self.connect_ssh_password(unique_name("ssh-mon-settings"))
        self.wait_for_monitoring_stats()
        self.open_settings_tab()
        assert self.wait(
            lambda: not self.monitoring_visible(),
            what="monitoring to hide on the settings tab",
        )

    def test_hides_when_all_tabs_closed(self):
        self.connect_ssh_password(unique_name("ssh-mon-close-all"))
        self.wait_for_monitoring_stats()
        self.close_all_tabs()
        assert self.wait(
            lambda: not self.monitoring_visible(),
            what="monitoring to hide with no tabs",
        )
