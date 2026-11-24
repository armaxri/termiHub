"""Product run: the SSH chip while down and Enter in an ended terminal, live (#5966).

Follow-up to #5955, whose live grade
(``test_product_run_session_end_consistency.py``) uses only local shells and
could not press a real key in a terminal. Here the run's own native sshd
(:mod:`termihub_harness.product_run.hosts`) drops an SSH session server-side,
and the ``terminalKey`` bridge verb presses Enter through xterm's input path,
the way a real key reaches the app's key routing.

Steps: the status-bar SSH chip is normal while the session is live, greys and
reads "Not connected." while it is down, and is normal again after Enter
reconnects it; Enter in a local terminal whose shell exited restarts it.

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The ``test_grade_*`` functions grade
fixed measurements without an app and run in the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any, Optional

import pytest

from termihub_harness import (
    SSH_HOST,
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.bridge import BridgeError
from termihub_harness.native_ssh import NativeSshServerControl
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.session_end_consistency import ssh_chip_problems
from termihub_harness.product_run.session_end_live import chip_reading, enter_action_problems
from termihub_harness.product_run.ssh_steps import SshPhaseUi

STRIP = "terminal-disconnect-overlay"
ACTION_BTN = "terminal-disconnect-reconnect-btn"
CHIP = "status-bar-ssh"
DOWN_CLASS = "status-bar__item--down"


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_chip_reading_feeds_the_chip_grade():
    down = chip_reading(
        data_down="true",
        class_attr="status-bar__item  status-bar__item--down ",
        aria_label=" Not connected. SSH: arne@127.0.0.1:22400, encrypted.",
    )
    assert down["classes"] == ["status-bar__item", "status-bar__item--down"]
    assert ssh_chip_problems(session_down=True, **down) == []
    live = chip_reading(
        data_down=None, class_attr="status-bar__item", aria_label="SSH: arne@127.0.0.1:22400"
    )
    assert ssh_chip_problems(session_down=False, **live) == []


def test_grade_a_missing_chip_reads_as_not_greyed():
    # A chip that is not rendered at all reads as empty markup: down fails.
    empty = chip_reading(data_down=None, class_attr=None, aria_label=None)
    assert empty == {"data_down": None, "classes": [], "aria_label": ""}
    problems = ssh_chip_problems(session_down=True, **empty)
    assert any("live secure session" in p for p in problems)


def test_grade_enter_restarted_the_local_shell():
    scrollback = "$ exit\n[Process exited]\n— restarted 10:11:12 —\n$ "
    assert (
        enter_action_problems(
            action="restart", strip_up=False, session_live=True, scrollback=scrollback
        )
        == []
    )


def test_grade_enter_reconnected_the_ssh_session():
    assert (
        enter_action_problems(
            action="reconnect", strip_up=False, session_live=True, scrollback="— reconnected —"
        )
        == []
    )


def test_grade_an_enter_that_did_nothing_fails():
    # The pre-#5955 shape: Enter in the dead terminal is ignored.
    problems = enter_action_problems(
        action="restart", strip_up=True, session_live=False, scrollback="[Process exited]\n"
    )
    assert any("still up after Enter" in p for p in problems)
    assert any("did not restart" in p for p in problems)
    # The marker is only graded once the restart happened.
    assert not any("restarted hh:mm:ss" in p for p in problems)


def test_grade_a_restart_marked_reconnected_fails():
    problems = enter_action_problems(
        action="restart",
        strip_up=False,
        session_live=True,
        scrollback="[Process exited]\n— reconnected 10:11:12 —\n",
    )
    assert any("'— reconnected'" in p for p in problems)


def test_grade_an_unknown_strip_action_fails():
    problems = enter_action_problems(
        action=None, strip_up=False, session_live=True, scrollback=""
    )
    assert problems == ["the strip's action before Enter was None, not restart / reconnect"]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunSessionEndLive(
    ProductRunUi, SshPhaseUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Session end live"
    request_timeout = 90.0

    def _chip(self) -> dict[str, Any]:
        """The status-bar SSH chip's state inputs, empty when it is not shown."""
        if not self.driver.exists(CHIP):
            return chip_reading(data_down=None, class_attr=None, aria_label=None)
        return chip_reading(
            data_down=self.driver.get_attribute(CHIP, "data-down"),
            class_attr=self.driver.get_attribute(CHIP, "class"),
            aria_label=self.driver.get_attribute(CHIP, "aria-label"),
        )

    def _grade_chip(self, *, session_down: bool, label: str) -> list[str]:
        """Wait briefly for the chip to show the state, then grade what it shows."""
        try:
            self.wait(
                lambda: (self._chip()["data_down"] == "true") == session_down
                and self.driver.exists(CHIP),
                timeout=20.0,
                what=f"the SSH chip to read {'down' if session_down else 'live'}",
            )
        except AssertionError:
            pass  # graded below on what the chip shows
        chip = self._chip()
        self.shot(label=label)
        self.evidence(
            f"chip data-down {chip['data_down']!r}; down class "
            f"{DOWN_CLASS in chip['classes']}; name {chip['aria_label']!r}"
        )
        return ssh_chip_problems(session_down=session_down, **chip)

    def _press_enter(self, tab: str) -> Optional[str]:
        """Press Enter in ``tab``'s terminal; returns the strip action it ran."""
        action = self.driver.get_attribute(ACTION_BTN, "data-action")
        self.evidence(f"strip action {action!r}; pressing Enter in the terminal")
        self.driver.terminal_key("Enter", tab)
        return action

    def _strip_up(self) -> bool:
        try:
            return self.driver.exists(STRIP)
        except BridgeError:
            return True

    def test_10_ssh_chip_down_and_enter_reconnects(self):
        name = unique_name("pr-end-live-ssh")
        tab = ""
        with self.step(
            "session-end.ssh-chip-live",
            "The status-bar SSH chip reads as a live secure session while connected (#5966)",
            expect="an SSH tab with a shell; the status-bar SSH chip in its normal colour",
        ):
            native = self.need_native()
            control = NativeSshServerControl(native.target)
            before = control.session_pids()
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=native.target.port, username=native.target.username,
                auth_method="key", key_path=str(native.client_key), auto_reconnect=False,
                connect=True,
            )
            self.evidence(f"host-key prompts accepted: {self.accept_all_hostkeys(timeout=15.0)}")
            tab = self.tab_id_of(name)
            self.wait_connected(tab)
            self.switch_to_tab(tab)
            self.echo_round_trip(tab, "PR_END_LIVE_BEFORE_DROP")
            pids = self.wait(
                lambda: (control.session_pids() - before) or False, what="its sshd session"
            )
            problems = self._grade_chip(session_down=False, label="chip-live")
            assert not problems, problems
        with self.step(
            "session-end.ssh-chip-down",
            "A server-side drop greys the SSH chip and names it 'Not connected.' (#5966)",
            expect="the SSH tab with the session-end strip ('Press Enter to reconnect.'); the "
            "status-bar SSH chip greyed out",
        ):
            self.require("session-end.ssh-chip-live")
            self.evidence(f"killing sshd session(s) {sorted(pids)}")
            control.kill_sessions(pids)
            self.wait(self._strip_up, timeout=60.0, what="the session-end strip")
            self.wait(
                lambda: self.session_status(tab) != "connected",
                timeout=60.0,
                what="the session to read as down",
            )
            problems = self._grade_chip(session_down=True, label="chip-down")
            assert not problems, problems
        with self.step(
            "session-end.ssh-enter-reconnects",
            "Enter in the dropped SSH terminal reconnects it; the chip is normal again (#5966)",
            expect="the same SSH tab with a live shell and the marker echoed; no strip; the "
            "status-bar SSH chip in its normal colour",
        ):
            self.require("session-end.ssh-chip-down")
            action = self._press_enter(tab)
            self.accept_all_hostkeys(timeout=5.0)
            try:
                self.wait_connected(tab, timeout=60.0)
            except AssertionError:
                pass  # graded below
            live = self.session_status(tab) == "connected"
            if live:
                self.echo_round_trip(tab, "PR_END_LIVE_RECONNECTED")
            problems = enter_action_problems(
                action=action,
                strip_up=self._strip_up(),
                session_live=live,
                scrollback=self.driver.read_terminal(tab),
            )
            if live:
                problems += self._grade_chip(session_down=False, label="chip-reconnected")
            else:
                self.shot(label="enter-ignored")
            assert not problems, problems
        self.close_all_tabs()

    def test_20_enter_restarts_an_ended_local_shell(self):
        with self.step(
            "session-end.local-enter-restarts",
            "Enter in a local terminal whose shell exited restarts it (#5966)",
            expect="the same local tab with a fresh prompt below '— restarted hh:mm:ss —'; no "
            "session-end strip",
        ):
            name = unique_name("pr-end-live-local")
            self.switch_to_connections_sidebar()
            self.create_local_connection(name, connect=True)
            tab = self.wait(lambda: self.find_tab(name), what="the local tab")["id"]
            self.switch_to_tab(tab)
            self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
            self.run_command("exit")
            self.wait(lambda: self.terminal_session_exited(tab), what="the shell to exit")
            self.wait(self._strip_up, timeout=30.0, what="the session-end strip")
            self.shot(label="exited")
            action = self._press_enter(tab)
            try:
                self.wait(
                    lambda: not self._strip_up() and not self.terminal_session_exited(tab),
                    timeout=30.0,
                    what="Enter to restart the shell",
                )
                self.wait(
                    lambda: "— restarted" in self.driver.read_terminal(tab),
                    timeout=10.0,
                    what="the restart marker",
                )
            except AssertionError:
                pass  # graded below
            self.shot(label="after-enter")
            problems = enter_action_problems(
                action=action,
                strip_up=self._strip_up(),
                session_live=not self.terminal_session_exited(tab),
                scrollback=self.driver.read_terminal(tab),
            )
            self.evidence("Enter restarted the shell" if not problems else repr(problems))
            assert not problems, problems
        self.close_all_tabs()
