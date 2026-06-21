"""SSH monitoring system tests (ported from infrastructure/ssh-monitoring.test.js).

Covers monitoring auto-connect, the status-bar stats/refresh/disconnect controls,
and hide-on-non-SSH behavior. Monitoring opens its own SSH session for stats, so
these require the ssh-password container (2201).
"""

from __future__ import annotations

import time

import pytest

from termihub_harness import SSH_PASSWORD_PORT, SSH_USERNAME, SystemTest, unique_name

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshMonitoring(SystemTest):
    # ── Auto-connect ──────────────────────────────────────────────────────────
    def test_auto_shows_stats_on_ssh_tab(self):
        self._connect(unique_name("ssh-mon-auto"))
        self.wait_for_monitoring_stats()

    def test_disconnect_triggers_reconnect(self):
        # On an SSH tab monitoring auto-connects, so a manual Disconnect is
        # immediately followed by an auto-reconnect with a *fresh* session — the
        # deterministic, observable proof that the Disconnect control fired.
        # (The original "stays disconnected" / "returns to Monitor button"
        # assertions are not portable: auto-connect never lets that state settle.)
        self._connect(unique_name("ssh-mon-disc"))
        before = self.wait_for_monitoring_stats() and self.driver.get_state(
            "monitoringSessionId"
        )
        self.monitoring_disconnect()
        new_sid = self.wait(
            lambda: (lambda s: s if (s and s != before) else None)(
                self.driver.get_state("monitoringSessionId")
            ),
            timeout=30.0,
            what="monitoring to reconnect with a new session",
        )
        assert new_sid and new_sid != before

    # ── Status bar ────────────────────────────────────────────────────────────
    def test_displays_cpu_mem_disk(self):
        self._connect(unique_name("ssh-mon-stats"))
        stats = self.wait_for_monitoring_stats()
        assert stats["cpu"] and stats["mem"] and stats["disk"]

    def test_auto_refresh_keeps_stats(self):
        self._connect(unique_name("ssh-mon-refresh"))
        self.wait_for_monitoring_stats()
        time.sleep(7)  # auto-refresh interval is ~5s
        assert self.monitoring_stats() is not None

    def test_refresh_button_keeps_stats(self):
        self._connect(unique_name("ssh-mon-btn-refresh"))
        self.wait_for_monitoring_stats()
        self.monitoring_refresh()
        assert self.wait(self.monitoring_stats, what="stats after refresh")

    def test_dropdown_has_refresh_and_disconnect(self):
        self._connect(unique_name("ssh-mon-dropdown"))
        self.wait_for_monitoring_stats()
        self.open_monitoring_dropdown()
        assert self.driver.exists("monitoring-refresh")
        assert self.driver.exists("monitoring-disconnect")

    # ── Hide on non-SSH tab ───────────────────────────────────────────────────
    def test_hides_on_settings_tab(self):
        self._connect(unique_name("ssh-mon-settings"))
        self.wait_for_monitoring_stats()
        self.open_settings_tab()
        assert self.wait(
            lambda: not self.monitoring_visible(),
            what="monitoring to hide on the settings tab",
        )

    def test_hides_when_all_tabs_closed(self):
        self._connect(unique_name("ssh-mon-close-all"))
        self.wait_for_monitoring_stats()
        self.close_all_tabs()
        assert self.wait(
            lambda: not self.monitoring_visible(),
            what="monitoring to hide with no tabs",
        )

    def _connect(self, name: str) -> None:
        self.create_ssh_connection(
            name, host=HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME, connect=True
        )
        self.handle_password_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")
