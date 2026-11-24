"""Product run: every session end reads the same way (#5955).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261124T122947Z`` (terminal, reconnect-model, drop) saw a local exit named
"Session ended" for code 0 but "Process exited (code 3)" for code 3, "—
reconnected —" after a local Restart, the red network-drop plug on an exited
local tab, "[Process exited with code 3]" above the shell's last output line,
SSH and agent notices with different hints and dismiss controls, a "View
scrollback" button beside the visible scrollback, and a green SSH status-bar
chip while the session was down.

Now a local exit reads "Process exited (code N)" for every code with a
process icon and a neutral stop marker on its tab; the exit line is written
after the last output; Restart marks "— restarted hh:mm:ss —"; every strip
says "Press Enter to restart / reconnect." and has one dismiss control (its x);
the SSH chip greys while its session is down.

The live grade uses no servers: a local shell prints a last line and exits
with code 3, another exits with code 0. The SSH chip's grade
(:func:`ssh_chip_problems`) is app-free here; the drop run's SSH fixture shows
it on screen.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

import re
import sys
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.session_end_consistency import (
    end_notice_problems,
    exit_line_order_problems,
    local_exit_problems,
    restart_marker_problems,
    ssh_chip_problems,
)

STRIP = "terminal-disconnect-overlay"
RESTART = "terminal-disconnect-reconnect-btn"
DISMISS = "terminal-disconnect-dismiss-btn"
LAST_LINE = "pr-last-line-before-exit"
ICON_KINDS = ("exited", "ended", "user", "device", "link")


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_one_name_for_every_local_exit():
    for code in (0, 3):
        assert (
            local_exit_problems(
                heading=f"Process exited (code {code})",
                code=code,
                icon_kind="exited",
                tab_status="exited",
            )
            == []
        )


def test_grade_the_old_code_0_wording_and_plug_fail():
    # The round-2 shape: code 0 titled "Session ended" with a check icon, and
    # the tab keeping the red network-drop plug.
    problems = local_exit_problems(
        heading="Session ended", code=0, icon_kind="ended", tab_status="disconnected"
    )
    assert any("'Process exited (code 0)'" in p for p in problems)
    assert any("process icon" in p for p in problems)
    assert any("network-drop plug" in p for p in problems)


def test_grade_the_exit_line_after_the_last_output_passes():
    scrollback = (
        "$ printf 'x'; exit 3\n"
        f"{LAST_LINE}\n"
        "\n"
        "[Process exited with code 3]\n"
        "— restarted 13:30:35 —\n"
    )
    assert exit_line_order_problems(scrollback=scrollback, last_output=LAST_LINE) == []


def test_grade_the_exit_line_above_the_last_output_fails():
    # The R-013 shape: the exit line above "none found.".
    scrollback = "Deleting expired sessions...\n[Process exited with code 3]\nnone found.\n"
    problems = exit_line_order_problems(scrollback=scrollback, last_output="none found.")
    assert any("below the exit line" in p for p in problems)
    assert any("process output below the exit line" in p for p in problems)
    assert exit_line_order_problems(scrollback="none found.\n", last_output="none found.") == [
        "no '[Process exited…]' line in the scrollback"
    ]


def test_grade_a_local_restart_is_marked_restarted():
    assert restart_marker_problems(scrollback="[Process exited]\n— restarted 09:05:07 —\n") == []
    old = "[Process exited]\n— reconnected 09:05:07 — new session; running programs were lost\n"
    problems = restart_marker_problems(scrollback=old)
    assert any("no '— restarted" in p for p in problems)
    assert any("'— reconnected'" in p for p in problems)


def test_grade_one_strip_layout_for_every_kind():
    local = "Process exited (code 3) Scrollback is kept. Press Enter to restart. Restart"
    assert (
        end_notice_problems(text=local, action="restart", buttons=["Restart"], dismiss_controls=1)
        == []
    )
    ssh = (
        "Session disconnected The network connection was lost. Scrollback is kept. "
        "Press Enter to reconnect. Reconnect"
    )
    assert (
        end_notice_problems(text=ssh, action="reconnect", buttons=["Reconnect"], dismiss_controls=1)
        == []
    )


def test_grade_the_old_ssh_strip_fails():
    # The R-010 / R-012 shape: no Enter hint and "View scrollback" beside the x.
    old = "Session disconnected The network connection was lost. Scrollback is kept."
    problems = end_notice_problems(
        text=old, action="reconnect", buttons=["Reconnect", "View scrollback"], dismiss_controls=1
    )
    assert any("'Press Enter to reconnect.'" in p for p in problems)
    assert any("'View scrollback'" in p for p in problems)
    assert any(
        "exactly one" in p
        for p in end_notice_problems(
            text=old + " Press Enter to reconnect.",
            action="reconnect",
            buttons=["Reconnect"],
            dismiss_controls=0,
        )
    )


def test_grade_the_ssh_chip_greys_while_down():
    down = "Not connected. SSH: arne@127.0.0.1:22400, encrypted, host key trusted."
    assert (
        ssh_chip_problems(
            session_down=True,
            data_down="true",
            classes=["status-bar__item", "status-bar__item--down"],
            aria_label=down,
        )
        == []
    )
    live = "SSH: arne@127.0.0.1:22400, encrypted, host key trusted. Show connection security"
    assert (
        ssh_chip_problems(
            session_down=False, data_down=None, classes=["status-bar__item"], aria_label=live
        )
        == []
    )


def test_grade_the_green_chip_on_a_dropped_session_fails():
    # The R-011 shape: the chip looks live while the session is down.
    live = "SSH: arne@127.0.0.1:22400, encrypted, host key trusted. Show connection security"
    problems = ssh_chip_problems(
        session_down=True, data_down=None, classes=["status-bar__item"], aria_label=live
    )
    assert any("live secure session" in p for p in problems)
    assert any("'Not connected.'" in p for p in problems)


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the grade exits a POSIX shell")
class TestProductRunSessionEndConsistency(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Session end consistency"
    request_timeout = 90.0

    def _ended_local_tab(self, name: str, command: str) -> str:
        """Open local connection ``name`` and run ``command``, which ends the shell."""
        self.switch_to_connections_sidebar()
        self.create_local_connection(name, connect=True)
        tab = self.wait(lambda: self.find_tab(name), what="the local tab")["id"]
        self.switch_to_tab(tab)
        self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
        self.run_command(command)
        self.wait(lambda: self.terminal_session_exited(tab), what="the shell to exit")
        self.wait(lambda: self.driver.exists(STRIP), timeout=30.0, what="the session-end strip")
        return tab

    def _icon_kind(self) -> Optional[str]:
        return next(
            (k for k in ICON_KINDS if self.driver.exists(f"terminal-disconnect-icon-{k}")), None
        )

    def _tab_status(self, tab: str) -> Optional[str]:
        classes = self.driver.get_attribute(f"tab-state-dot-{tab}", "class") or ""
        match = re.search(r"tab__state-dot--(\w+)", classes)
        return match.group(1) if match else None

    def _grade_strip(self, tab: str, *, code: int) -> list[Any]:
        text = " ".join(self.driver.get_text(STRIP).split())
        heading = re.match(r"Process exited(?: \(code -?\d+\))?|[^.]*?(?= Scrollback|$)", text)
        strip = self.driver.measure_element(STRIP, "buttons")
        shown = [b for b in strip["items"] if b.get("visible", True)]
        buttons = [(b.get("text") or "").strip() for b in shown]
        dismiss = sum(1 for b in shown if b.get("testId") == DISMISS)
        action = self.driver.get_attribute(RESTART, "data-action")
        status = self._tab_status(tab)
        icon = self._icon_kind()
        self.shot(label=f"exit-{code}")
        self.evidence(
            f"strip {text!r}; buttons {buttons}; dismiss {dismiss}; action {action!r}; "
            f"icon {icon!r}; tab marker {status!r}"
        )
        problems: list[Any] = local_exit_problems(
            heading=heading.group(0) if heading else text,
            code=code,
            icon_kind=icon,
            tab_status=status,
        )
        problems += end_notice_problems(
            text=text, action=action, buttons=buttons, dismiss_controls=dismiss
        )
        return problems

    def test_10_local_exit_with_a_last_line(self):
        with self.step(
            "terminal.session-end-exit-3",
            "A local shell that prints a line and exits with code 3 reads 'Process exited (code "
            "3)', marks its tab with a stop sign and writes the exit line last (#5955)",
            expect="a strip with a process icon, 'Process exited (code 3)', 'Scrollback is kept. "
            "Press Enter to restart.', Restart and one x (no 'View scrollback'); the tab shows a "
            "grey stop sign, not the red plug; in the scrollback 'pr-last-line-before-exit' comes "
            "before '[Process exited with code 3]'",
        ):
            tab = self._ended_local_tab(
                unique_name("pr-end-consistency"), f"printf '%s\\n' {LAST_LINE}; exit 3"
            )
            self.wait(
                lambda: "[Process exited" in self.driver.read_terminal(tab),
                what="the exit line",
            )
            problems = self._grade_strip(tab, code=3)
            scrollback = self.driver.read_terminal(tab)
            problems += exit_line_order_problems(scrollback=scrollback, last_output=LAST_LINE)
            assert not problems, problems
        with self.step(
            "terminal.session-end-restarted",
            "Restart starts the shell again and marks the scrollback '— restarted' (#5955)",
            expect="the same tab with a fresh prompt below '— restarted hh:mm:ss —'; no "
            "'— reconnected' line",
        ):
            self.require("terminal.session-end-exit-3")
            self.driver.click(RESTART)
            self.wait(
                lambda: not self.driver.exists(STRIP) and not self.terminal_session_exited(tab),
                timeout=30.0,
                what="Restart to start a new shell",
            )
            self.wait(
                lambda: "— restarted" in self.driver.read_terminal(tab), what="the restart marker"
            )
            self.shot(label="restarted")
            problems = restart_marker_problems(scrollback=self.driver.read_terminal(tab))
            self.evidence("restart marker written" if not problems else repr(problems))
            assert not problems, problems
        self.close_all_tabs()

    def test_20_local_exit_0_reads_the_same(self):
        with self.step(
            "terminal.session-end-exit-0",
            "A local shell that exits normally reads 'Process exited (code 0)', like any other "
            "exit (#5955)",
            expect="a strip with a process icon, 'Process exited (code 0)', 'Press Enter to "
            "restart.', Restart and one x; no 'Session ended', no check icon; the tab shows a "
            "grey stop sign",
        ):
            tab = self._ended_local_tab(unique_name("pr-end-consistency-0"), "exit")
            problems = self._grade_strip(tab, code=0)
            assert not problems, problems
        self.close_all_tabs()
