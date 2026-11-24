"""Product run: host-monitoring states and host-menu wording (#5840).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Usability review of run ``20261123T215628Z``:

* **Pause vs Stop (R-039).** The host menu offers both; each now carries a
  description line saying what it does, and Stop uses a stop icon instead of
  the empty-checkbox square that read as an unticked option.
* **No metrics, but why? (R-040).** A connected monitor without a sample shows
  exactly one state chip — "Waiting for stats…", a muted "Monitoring
  unavailable" with the reason in its tooltip, or the unsupported state —
  never a bare host chip.
* **One name for the host (R-099).** The menu is headed by the host as
  configured (the chip's text); the machine's resolved hostname is a muted
  detail row, left out when it is the same name.

The grades are pure functions, checked without an app in the per-PR lane by
the tests at the bottom of this file.
"""

from __future__ import annotations

import socket
import subprocess
import sys
from collections.abc import Iterable
from typing import Optional

import pytest

from termihub_harness import (
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
from termihub_harness.native_ssh import fixture_argv
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi
from termihub_harness.ui.monitoring import (
    PAUSE_DESCRIPTION,
    PAUSE_LABEL,
    STOP_DESCRIPTION,
    STOP_LABEL,
    menu_item_label,
)

#: The chips that say why a connected monitor has no numbers (#5840).
STATE_CHIPS = ("monitoring-waiting", "monitoring-unavailable", "monitoring-unsupported")
#: Chips that already explain a stats-less monitor on their own.
OTHER_EXPLAINERS = ("monitoring-retry-btn", "monitoring-paused", "monitoring-stopped",
                    "monitoring-loading", "monitoring-error", "monitoring-agent-outdated")
#: The status-bar metric chips (``monitoring-<name>``).
METRIC_CHIPS = ("cpu", "mem", "disk", "swap", "net")


def lifecycle_menu_problems(pause_text: str, stop_text: str, stop_icon_class: str) -> list[str]:
    """What is wrong with the host menu's Pause / Stop items, or ``[]``."""
    problems: list[str] = []
    if menu_item_label(pause_text, PAUSE_DESCRIPTION) != PAUSE_LABEL:
        problems.append(f"pause item reads {pause_text!r}")
    if PAUSE_DESCRIPTION not in pause_text:
        problems.append("pause item has no description line")
    if menu_item_label(stop_text, STOP_DESCRIPTION) != STOP_LABEL:
        problems.append(f"stop item reads {stop_text!r}")
    if STOP_DESCRIPTION not in stop_text:
        problems.append("stop item has no description line")
    classes = stop_icon_class.split()
    if "lucide-square" in classes:
        problems.append("stop item uses the empty-checkbox square icon")
    if "lucide-circle-stop" not in classes:
        problems.append(f"stop item has no stop icon ({stop_icon_class!r})")
    return problems


def statsless_state_problems(present: Iterable[str]) -> list[str]:
    """What is wrong with a stats-less monitor's status bar, or ``[]``.

    ``present`` is the set of monitoring test ids on screen. A monitor showing
    the host chip and no metric must explain itself with exactly one state chip
    (or one of the chips that already explain it, like Retry or Paused).
    """
    shown = set(present)
    if any(f"monitoring-{c}" in shown for c in METRIC_CHIPS):
        return []
    states = [c for c in STATE_CHIPS if c in shown]
    if len(states) > 1:
        return [f"more than one state chip: {states}"]
    if states or any(c in shown for c in OTHER_EXPLAINERS):
        return []
    if "monitoring-host" in shown:
        return ["only the host chip: no waiting / unavailable / unsupported state"]
    return []


def menu_heading_problems(
    chip: str, heading: Optional[str], hostname: Optional[str], hostname_muted: bool
) -> list[str]:
    """What is wrong with the host menu's naming, or ``[]``.

    The menu heading must be the chip's name (the host as configured); a
    resolved hostname that differs is a muted detail, never a second headline.
    """
    problems: list[str] = []
    if heading is None:
        problems.append("the host menu has no heading")
    elif heading.strip() != chip.strip():
        problems.append(f"menu heading {heading!r} is not the chip's {chip!r}")
    if hostname is not None:
        if hostname.strip() == chip.strip():
            problems.append("the hostname row repeats the configured name")
        elif not hostname_muted:
            problems.append(f"resolved hostname {hostname!r} is not muted")
    return problems


def _free_port(start: int, span: int = 30) -> int:
    for port in range(start, start + span):
        with socket.socket() as sock:
            try:
                sock.bind((SSH_HOST, port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"no free port in {start}..{start + span}")


@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunMonitoringStates(
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
    phase = "Monitoring states"
    request_timeout = 90.0

    def _present(self) -> list[str]:
        ids = ["monitoring-host", *STATE_CHIPS, *OTHER_EXPLAINERS]
        ids += [f"monitoring-{c}" for c in METRIC_CHIPS]
        return [t for t in ids if self.driver.exists(t)]

    def _ssh_tab(self, label: str, port: Optional[int] = None) -> str:
        native = self.need_native()
        name = unique_name(label)
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.create_ssh_connection(
            name, host=SSH_HOST, port=port or native.target.port,
            username=native.target.username, auth_method="key",
            key_path=str(native.client_key), connect=True,
        )
        self.accept_all_hostkeys(timeout=10.0)
        tab_id = self.tab_id_of(name)
        self.wait_connected(tab_id)
        return tab_id

    def test_01_menu_explains_pause_and_stop(self):
        with self.step(
            "monitoring.states.menu",
            "The host menu explains Pause and Stop, uses a stop icon and is headed by the host",
            expect="the open host menu: host heading, Pause and Stop each with a description line",
        ):
            self._ssh_tab("pr-mon-states")
            self.wait_for_monitoring_stats(timeout=60.0)
            self.open_monitoring_dropdown()
            self.shot(label="menu")
            pause = self.driver.get_text("monitoring-pause-btn")
            stop = self.driver.get_text("monitoring-stop")
            icon = self.driver.get_attribute("monitoring-stop-icon", "class") or ""
            self.evidence(f"pause {pause!r}; stop {stop!r}; stop icon {icon!r}")
            problems = lifecycle_menu_problems(pause, stop, icon)

            chip = self.driver.get_text("monitoring-host")
            heading = (self.driver.get_text("monitoring-menu-host")
                       if self.driver.exists("monitoring-menu-host") else None)
            hostname = (self.driver.get_text("monitoring-info-host")
                        if self.driver.exists("monitoring-info-host") else None)
            muted = "monitoring-menu__value--muted" in (
                self.driver.get_attribute("monitoring-info-host", "class") or ""
            ) if hostname is not None else False
            self.evidence(f"chip {chip!r}; heading {heading!r}; hostname {hostname!r} muted={muted}")
            problems += menu_heading_problems(chip, heading, hostname, muted)
            assert not problems, problems
        self.close_all_tabs()

    def test_02_unsupported_host_explains_itself(self):
        with self.step(
            "monitoring.states.unavailable",
            "A host that cannot report shows a monitoring state chip, never a bare host chip",
            expect="the SSH tab with a muted 'Monitoring unavailable' state and its reason",
        ):
            native = self.need_native()
            port = _free_port(native.target.port + 40)
            out = subprocess.run(
                fixture_argv("variant-up", native.target.state_dir, "--variant", "pr-nosh-states",
                             "--port", str(port), "--setenv", "PATH=/nonexistent"),
                capture_output=True, text=True, timeout=120,
            )
            assert out.returncode == 0, out.stderr[-400:]
            self._ssh_tab("pr-mon-states-nosh", port)
            # Every poll on the way must explain the missing numbers, not just the end state.
            bad: list[tuple[list[str], list[str]]] = []
            polls = 0

            def settled() -> Optional[list[str]]:
                nonlocal polls
                polls += 1
                present = self._present()
                problems = statsless_state_problems(present)
                if problems:
                    bad.append((present, problems))
                done = "monitoring-unsupported" in present or "monitoring-unavailable" in present
                return present if done else None

            present = self.wait(settled, timeout=90.0, interval=1.0,
                                what="a monitoring-unavailable state")
            self.shot(label="unavailable")
            chip = next(c for c in ("monitoring-unsupported", "monitoring-unavailable") if c in present)
            reason = self.driver.get_attribute(chip, "title") or ""
            self.evidence(f"status bar {present}; tooltip {reason!r}; polls {polls}")
            assert not bad, f"unexplained stats-less states on the way: {bad[:3]}"
            assert reason, "the unavailable state has no reason tooltip"
        self.close_all_tabs()


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
_PAUSE = f"{PAUSE_LABEL}\n{PAUSE_DESCRIPTION}"
_STOP = f"{STOP_LABEL}{STOP_DESCRIPTION}"


def test_described_items_with_a_stop_icon_pass():
    assert lifecycle_menu_problems(_PAUSE, _STOP, "lucide lucide-circle-stop") == []


def test_the_empty_square_icon_is_named():
    problems = lifecycle_menu_problems(_PAUSE, _STOP, "lucide lucide-square")
    assert "stop item uses the empty-checkbox square icon" in problems


def test_an_undescribed_item_is_named():
    problems = lifecycle_menu_problems(PAUSE_LABEL, STOP_LABEL, "lucide-circle-stop")
    assert problems == ["pause item has no description line", "stop item has no description line"]


def test_a_renamed_stop_is_named():
    assert lifecycle_menu_problems(_PAUSE, f"Disconnect{STOP_DESCRIPTION}", "lucide-circle-stop") == [
        f"stop item reads 'Disconnect{STOP_DESCRIPTION}'"
    ]


def test_menu_item_label_strips_the_description():
    assert menu_item_label(_PAUSE, PAUSE_DESCRIPTION) == PAUSE_LABEL
    assert menu_item_label(_STOP, STOP_DESCRIPTION) == STOP_LABEL
    assert menu_item_label(" Stop monitoring ", STOP_DESCRIPTION) == STOP_LABEL


def test_a_bare_host_chip_is_named():
    assert statsless_state_problems(["monitoring-host"]) == [
        "only the host chip: no waiting / unavailable / unsupported state"
    ]


def test_each_state_chip_explains_a_stats_less_monitor():
    for chip in (*STATE_CHIPS, "monitoring-retry-btn", "monitoring-paused"):
        assert statsless_state_problems(["monitoring-host", chip]) == [], chip


def test_two_state_chips_are_named():
    shown = ["monitoring-host", "monitoring-waiting", "monitoring-unavailable"]
    assert statsless_state_problems(shown) == [
        "more than one state chip: ['monitoring-waiting', 'monitoring-unavailable']"
    ]


def test_metrics_need_no_state_chip():
    assert statsless_state_problems(["monitoring-host", "monitoring-mem"]) == []


def test_menu_headed_by_the_configured_host_passes():
    assert menu_heading_problems("127.0.0.1", "127.0.0.1", "box.fritz.box", True) == []
    assert menu_heading_problems("web-1", "web-1", None, False) == []


def test_a_second_host_name_as_headline_is_named():
    assert menu_heading_problems("127.0.0.1", "box.fritz.box", None, False) == [
        "menu heading 'box.fritz.box' is not the chip's '127.0.0.1'"
    ]
    assert menu_heading_problems("127.0.0.1", "127.0.0.1", "box.fritz.box", False) == [
        "resolved hostname 'box.fritz.box' is not muted"
    ]


def test_a_missing_heading_is_named():
    assert menu_heading_problems("127.0.0.1", None, None, False) == ["the host menu has no heading"]
