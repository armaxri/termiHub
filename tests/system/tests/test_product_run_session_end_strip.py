"""Product run: a session end is a strip above the output, and a process exit says so.

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261124T080801Z`` saw the disconnected / session-ended card float over the
terminal and cut the first or last output lines (#5908: R-003, R-005, R-009),
and a local shell that exited with code 3 titled "Session ended" with a
no-wifi icon and "Reconnect"; a clean exit 0 also offered "Reconnect" (#5910:
R-004, R-021).

The strip now spans the top of the pane and pushes the terminal down below it,
so every output line stays readable and selectable. A process exit reads
"Process exited (code N)" with a process icon and Restart — a local exit with
code 0 too (#5955); a remote session's normal end reads "Session ended" with
Reconnect; only a dropped link says "Session ended".
The live grade uses no servers: a local shell exits with code 3, another with 0.

The plugin crash notice (#5916) is the same strip; its grade
(:func:`plugin_exit_problems`) is app-free only, as the product run has no
crashing plugin fixture yet.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any

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
from termihub_harness.product_run.session_end_strip import (
    end_copy_problems,
    plugin_exit_problems,
    strip_layout_problems,
)

STRIP = "terminal-disconnect-overlay"
RESTART = "terminal-disconnect-reconnect-btn"


# ── app-free grade tests ──────────────────────────────────────────────────
def _rect(x: float, y: float, w: float, h: float) -> dict[str, float]:
    return {"x": x, "y": y, "width": w, "height": h}


PANE = _rect(490, 160, 1500, 1040)
TOP_STRIP = _rect(490, 160, 1500, 44)
PUSHED_TERMINAL = _rect(490, 204, 1500, 996)


def test_grade_a_top_strip_over_a_pushed_down_terminal_passes():
    assert strip_layout_problems(strip=TOP_STRIP, pane=PANE, terminal=PUSHED_TERMINAL) == []


def test_grade_the_old_floating_card_fails():
    # The R-003 / R-009 shape: a 500px card near the pane top, the terminal
    # still starting at the pane top under it.
    card = _rect(995, 172, 500, 290)
    problems = strip_layout_problems(strip=card, pane=PANE, terminal=PANE)
    assert any("not at the pane top" in p for p in problems)
    assert any("does not span the pane" in p for p in problems)
    assert any("output are covered" in p for p in problems)


def test_grade_a_full_width_strip_that_still_covers_the_first_lines_fails():
    problems = strip_layout_problems(strip=TOP_STRIP, pane=PANE, terminal=PANE)
    assert problems == [
        "the terminal starts at 160, under the strip (bottom 204): 44px of output are covered"
    ]


def test_grade_a_process_exit_says_so_and_restarts():
    text = "Process exited (code 3) Scrollback is kept. Press Enter to restart. Restart"
    assert (
        end_copy_problems(text=text, cause="exited", buttons=["Restart"], local=True, code=3)
        == []
    )


def test_grade_the_old_process_exit_wording_fails():
    # The R-004 shape: a local exit 3 read as a lost connection with Reconnect.
    old = "Session ended The process exited with code 3. Scrollback is kept."
    problems = end_copy_problems(
        text=old, cause="exited", buttons=["Reconnect"], local=True, code=3
    )
    assert any("'Process exited (code 3)'" in p for p in problems)
    assert any("no lost connection" in p for p in problems)
    assert any("offers no 'Restart'" in p for p in problems)
    assert any("offers 'Reconnect'" in p for p in problems)


def test_grade_a_clean_exit_restarts_locally_and_reconnects_remotely():
    local = "Process exited (code 0) Scrollback is kept. Press Enter to restart."
    assert (
        end_copy_problems(text=local, cause="ended", buttons=["Restart"], local=True, code=0)
        == []
    )
    remote = "Session ended The session ended normally (exit code 0). Scrollback is kept."
    assert end_copy_problems(text=remote, cause="ended", buttons=["Reconnect"], local=False) == []
    # The R-021 shape: a local exit 0 offering Reconnect.
    assert end_copy_problems(text=local, cause="ended", buttons=["Reconnect"], local=True, code=0)
    # The #5955 shape: a local exit 0 with its own name.
    old = "Session ended The session ended normally (exit code 0). Scrollback is kept."
    problems = end_copy_problems(text=old, cause="ended", buttons=["Restart"], local=True, code=0)
    assert any("'Process exited (code 0)'" in p for p in problems)


def test_grade_a_dropped_link_keeps_the_network_wording():
    text = "Session ended The network connection was lost. Scrollback is kept."
    assert end_copy_problems(text=text, cause="network", buttons=["Reconnect"], local=False) == []
    assert end_copy_problems(
        text="Session ended", cause="network", buttons=["Reconnect"], local=False
    )


def _plugin(**overrides: Any) -> list[str]:
    args: dict[str, Any] = {
        "variant": "plugin-exit",
        "classes": ["terminal-disconnect-strip", "terminal-disconnect-strip--error"],
        "text": "The plugin stopped unexpectedly “Acme” ran in its own sandboxed process. "
        "Plugin process exited: signal SIGSEGV Restart session Close tab",
        "buttons": ["Restart session", "Close tab"],
        "keep_clear": 1,
    }
    args.update(overrides)
    return plugin_exit_problems(**args)


def test_grade_the_plugin_crash_strip_passes():
    # #5916: the plugin crash notice is the same top strip.
    assert _plugin() == []


def test_grade_the_old_full_pane_plugin_overlay_fails():
    problems = _plugin(
        variant=None,
        classes=["terminal-disconnect-overlay", "terminal-disconnect-overlay--error"],
        keep_clear=0,
    )
    assert any("not 'plugin-exit'" in p for p in problems)
    assert any("not the session-end strip" in p for p in problems)
    assert any("full-pane overlay" in p for p in problems)
    assert any("keep-clear" in p for p in problems)


def test_grade_a_plugin_strip_without_its_actions_fails():
    problems = _plugin(buttons=["Restart session"], keep_clear=2)
    assert any("'Close tab'" in p for p in problems)
    assert any("2 toast keep-clear zones" in p for p in problems)


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the grade exits a POSIX shell")
class TestProductRunSessionEndStrip(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Session end strip"
    request_timeout = 90.0

    def _ended_local_tab(self, name: str, command: str) -> str:
        """Open local connection ``name``, print a marker line, run ``command``."""
        self.switch_to_connections_sidebar()
        self.create_local_connection(name, connect=True)
        tab = self.wait(lambda: self.find_tab(name), what="the local tab")["id"]
        self.switch_to_tab(tab)
        self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
        self.run_command("echo first-line-must-stay-visible")
        self.run_command(command)
        self.wait(lambda: self.terminal_session_exited(tab), what="the shell to exit")
        self.wait(lambda: self.driver.exists(STRIP), timeout=30.0, what="the session-end strip")
        return tab

    def _grade(self, tab: str, *, code: int) -> None:
        strip = self.driver.measure_element(STRIP, "buttons")
        pane = self.driver.measure_element(f"terminal-context-trigger-{tab}")["rect"]
        terminal = self.driver.measure_element(f"terminal-renderer-{tab}")["rect"]
        cause = self.driver.get_attribute(STRIP, "data-cause")
        text = self.driver.get_text(STRIP)
        buttons: list[str] = [
            (b.get("text") or "").strip() for b in strip["items"] if b.get("visible", True)
        ]
        self.shot(label=f"exit-{code}")
        self.evidence(
            f"strip {strip['rect']} cause {cause!r}: {text!r}; buttons {buttons}; "
            f"pane {pane}; terminal {terminal}"
        )
        problems: list[Any] = strip_layout_problems(
            strip=strip["rect"], pane=pane, terminal=terminal
        )
        problems += end_copy_problems(
            text=text, cause=cause, buttons=buttons, local=True, code=code
        )
        assert not problems, problems

    def test_10_process_exit_is_a_strip_that_restarts(self):
        with self.step(
            "terminal.end-strip-exit-code",
            "A local shell that exits with code 3 shows a full-width strip above the output "
            "that says the process exited and offers Restart (#5908, #5910)",
            expect="a strip across the top of the terminal: a process icon, 'Process exited "
            "(code 3)', 'Scrollback is kept. Press Enter to restart.', Restart and an x; the "
            "terminal starts below the strip, 'first-line-must-stay-visible' and '[Process "
            "exited with code 3]' fully readable, nothing covered",
        ):
            tab = self._ended_local_tab(unique_name("pr-end-exit"), "exit 3")
            self._grade(tab, code=3)
        with self.step(
            "terminal.end-strip-restart",
            "Restart starts the shell again and the strip goes away (#5910)",
            expect="the same tab with a fresh prompt and no strip; the terminal fills the pane "
            "again",
        ):
            self.require("terminal.end-strip-exit-code")
            self.driver.click(RESTART)
            self.wait(
                lambda: not self.driver.exists(STRIP) and not self.terminal_session_exited(tab),
                timeout=30.0,
                what="Restart to start a new shell",
            )
            self.evidence("Restart started a new shell")
        self.close_all_tabs()

    def test_20_clean_exit_reads_process_exited(self):
        with self.step(
            "terminal.end-strip-clean-exit",
            "A local shell that ends normally reads 'Process exited (code 0)' with Restart, "
            "above the output, like any other exit (#5908, #5910, #5955)",
            expect="a strip across the top of the terminal: a process icon, 'Process exited "
            "(code 0)', 'Scrollback is kept. Press Enter to restart.', Restart and an x; no "
            "wifi icon, no 'Session ended' and no 'Reconnect'; all output readable below the "
            "strip",
        ):
            tab = self._ended_local_tab(unique_name("pr-end-clean"), "exit")
            self._grade(tab, code=0)
        self.close_all_tabs()
