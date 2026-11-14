"""Product run: host-monitoring defaults and wording (#5750, #5754).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Maintainer decisions of 2026-11-13:

* **Local shells show no metric chips by default (#5754).** The machine
  termiHub runs on has its own system monitor, so a local shell tab starts no
  monitor and the status bar shows no CPU / Mem / Disk / Net chip, unless the
  user turned on Settings ▸ Monitor local shells.
* **Remote sessions keep them, without Swap (#5754).** An SSH tab on the run's
  native sshd shows CPU, Mem, Disk and Net; Swap is selectable but not a
  default chip.
* **"Stop monitoring", not "Disconnect" (#5750).** The host menu item only
  stops the readings, never the SSH session, and the stopped state offers
  "Monitoring off · Start monitoring".

The chip-set check is a pure function, graded without an app in the per-PR
lane by the tests at the bottom of this file.
"""

from __future__ import annotations

import sys
import time
from collections.abc import Callable, Iterable

import pytest

from termihub_harness import (
    SETTINGS_REGION,
    SSH_HOST,
    ConnectionsUi,
    MonitoringUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi

#: Every status-bar host-metric chip (``monitoring-<name>``).
METRIC_CHIPS = ("cpu", "mem", "disk", "swap", "net")
#: The chips a remote session shows when the user never chose a set (#5754).
DEFAULT_REMOTE_CHIPS = ("cpu", "mem", "disk", "net")
STOP_LABEL = "Stop monitoring"


def chip_set_problems(shown: Iterable[str], expected: Iterable[str]) -> list[str]:
    """What is wrong with the status bar's metric chips, or ``[]`` when right."""
    shown_set, expected_set = set(shown), set(expected)
    problems = [f"unexpected '{c}' chip" for c in METRIC_CHIPS if c in shown_set - expected_set]
    problems += [f"missing '{c}' chip" for c in METRIC_CHIPS if c in expected_set - shown_set]
    return problems


@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunMonitoringDefaults(
    ProductRunUi,
    SshPhaseUi,
    MonitoringUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SettingsUi,
    SystemTest,
):
    phase = "Monitoring defaults"
    request_timeout = 90.0

    def _chips(self) -> list[str]:
        return [c for c in METRIC_CHIPS if self.driver.exists(f"monitoring-{c}")]

    def _ssh_tab(self, label: str) -> str:
        native = self.need_native()
        name = unique_name(label)
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.create_ssh_connection(
            name, host=SSH_HOST, port=native.target.port, username=native.target.username,
            auth_method="key", key_path=str(native.client_key), connect=True,
        )
        self.accept_all_hostkeys(timeout=10.0)
        tab_id = self.tab_id_of(name)
        self.wait_connected(tab_id)
        return tab_id

    def _hold(self, predicate: Callable[[], bool], seconds: float, what: str) -> None:
        """Fail if ``predicate`` turns true at any poll within ``seconds``."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            assert not predicate(), f"{what} within {seconds:.0f}s"
            time.sleep(1.0)

    def test_01_local_shell_has_no_metric_chips(self):
        with self.step(
            "monitoring.defaults.local",
            "A local shell tab shows no host-metric chips by default (#5754)",
            expect="a local shell tab with no CPU / Mem / Disk / Net chip in the status bar",
        ):
            setting = self.projection_region_cache(SETTINGS_REGION).get("monitorLocalShells")
            self.evidence(f"monitorLocalShells = {setting!r}")
            assert setting is not True, "the run profile opted in to local-shell monitoring"
            self.close_all_tabs()
            self.ensure_terminal()
            # Monitoring would auto-connect within a few seconds; hold to prove it does not.
            self._hold(lambda: bool(self._chips()), 8.0, "a metric chip on the local tab")
            assert not self.driver.exists("monitoring-host"), "a host chip on the local tab"
            self.evidence(f"chips on the local tab: {self._chips()}")
        self.close_all_tabs()

    def test_02_remote_session_shows_default_chips(self):
        with self.step(
            "monitoring.defaults.remote",
            "An SSH tab shows CPU, Mem, Disk and Net, and no Swap chip by default (#5754)",
            expect="the SSH tab with CPU / Mem / Disk / Net chips and no Swap chip",
        ):
            setting = self.projection_region_cache(SETTINGS_REGION).get("statusBarMetrics")
            self.evidence(f"statusBarMetrics = {setting!r}")
            assert setting is None, "the run profile chose its own chip set"
            self._ssh_tab("pr-mon-defaults")
            self.wait_for_monitoring_stats(timeout=60.0)
            self.wait(lambda: self.driver.exists("monitoring-cpu"), timeout=30.0,
                      what="CPU past priming")
            shown = self._chips()
            self.evidence(f"chips on the SSH tab: {shown}")
            problems = chip_set_problems(shown, DEFAULT_REMOTE_CHIPS)
            assert not problems, problems

        with self.step(
            "monitoring.defaults.stop-label",
            "The host menu says 'Stop monitoring', not 'Disconnect' (#5750)",
            expect="the open host menu ending in 'Stop monitoring'",
        ):
            self.require("monitoring.defaults.remote")
            self.open_monitoring_dropdown()
            self.shot(label="menu")
            label = self.driver.get_text("monitoring-stop").strip()
            self.evidence(f"menu item {label!r}")
            assert label == STOP_LABEL, label
            menu = self.driver.get_text("monitoring-menu")
            assert "Disconnect" not in menu, menu
            self.driver.click("monitoring-stop")
            self.wait(lambda: self.driver.exists("monitoring-stopped"), what="the stopped state")
            stopped = self.driver.get_text("monitoring-stopped")
            self.evidence(f"stopped state {stopped!r}")
            assert "Start monitoring" in stopped, stopped
        self.close_all_tabs()


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def test_the_default_remote_chip_set_passes():
    assert chip_set_problems(["cpu", "mem", "disk", "net"], DEFAULT_REMOTE_CHIPS) == []


def test_a_swap_chip_in_the_default_set_is_named():
    shown = ["cpu", "mem", "disk", "swap", "net"]
    assert chip_set_problems(shown, DEFAULT_REMOTE_CHIPS) == ["unexpected 'swap' chip"]


def test_any_chip_on_a_local_tab_is_named():
    assert chip_set_problems(["mem", "disk"], ()) == ["unexpected 'mem' chip", "unexpected 'disk' chip"]


def test_a_missing_chip_is_named():
    assert chip_set_problems(["cpu", "mem"], DEFAULT_REMOTE_CHIPS) == [
        "missing 'disk' chip",
        "missing 'net' chip",
    ]
