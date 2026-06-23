"""Remote system-monitoring status-bar helpers (issue #831).

``MonitoringUi`` reads the monitoring chips in the status bar (cpu/mem/disk) and
drives the host dropdown's refresh/disconnect actions. SSH suites that assert on
monitoring mix this in alongside :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import Optional

from .base import HarnessMixin


class MonitoringUi(HarnessMixin):
    """Read monitoring stats and drive the host refresh/disconnect dropdown."""

    def monitoring_visible(self) -> bool:
        """Whether any monitoring status-bar element is present (any state)."""
        return any(
            self.driver.exists(test_id)
            for test_id in (
                "monitoring-connect-btn",
                "monitoring-loading",
                "monitoring-host",
                "monitoring-cpu",
            )
        )

    def monitoring_stats(self) -> Optional[dict[str, str]]:
        """The connected monitoring stats (cpu/mem/disk text), or None."""
        if not self.driver.exists("monitoring-cpu"):
            return None
        return {
            "cpu": self.driver.get_text("monitoring-cpu"),
            "mem": self.driver.get_text("monitoring-mem"),
            "disk": self.driver.get_text("monitoring-disk"),
        }

    def wait_for_monitoring_stats(self, *, timeout: float = 20.0) -> dict[str, str]:
        """Poll until monitoring has connected and shows stats; return them."""
        return self.wait(
            self.monitoring_stats, timeout=timeout, what="monitoring stats to appear"
        )

    def open_monitoring_dropdown(self) -> None:
        """Click the monitoring host chip to open its refresh/disconnect menu."""
        self.driver.click("monitoring-host")
        self.wait(
            lambda: self.driver.exists("monitoring-disconnect"),
            what="the monitoring dropdown",
        )

    def monitoring_refresh(self) -> None:
        """Open the monitoring dropdown and click Refresh."""
        self.open_monitoring_dropdown()
        self.driver.click("monitoring-refresh")

    def monitoring_disconnect(self) -> None:
        """Open the monitoring dropdown and click Disconnect."""
        self.open_monitoring_dropdown()
        self.driver.click("monitoring-disconnect")
