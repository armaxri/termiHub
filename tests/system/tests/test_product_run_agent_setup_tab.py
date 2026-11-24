"""Product run: the agent setup tab says when the setup is over (#5865).

After an agent setup the tab stayed open as a plain shell (follow-up from
#5822 / PR #5864): nothing on screen said whether the agent was installed,
and the user had to know to close it themselves.

The setup script now replaces the tab's shell (``exec sh setup.sh``), so the
session ends with the script's exit code, and the tab shows the session-end
strip (#5908) at the pane top: "Agent installed" with Close tab on success,
"Agent setup failed" with the reason on a failure. The tab is not closed on
its own, so the install output (version, path) stays readable.

The live grade runs in the remote-agent phase right after the real deploy
(``agent.setup.tab-finished`` in ``test_product_run_agent.py``), which owns
the run's sshd and the dev agent; hand-triggered only. The ``test_grade_*``
functions here grade fixed measurements without an app and run in the normal
lane.
"""

from __future__ import annotations

from termihub_harness.product_run.agent_setup_tab import HEADINGS, setup_tab_problems
from termihub_harness.product_run.session_end_strip import strip_layout_problems

INSTALLED_TEXT = (
    'Agent installed Connect "pr-agent-1" from the sidebar. Scrollback is kept. Close tab'
)


def _rect(x: float, y: float, w: float, h: float) -> dict[str, float]:
    return {"x": x, "y": y, "width": w, "height": h}


def test_grade_an_installed_strip_with_close_tab_passes():
    assert (
        setup_tab_problems(
            variant="agent-setup-installed",
            text=INSTALLED_TEXT,
            buttons=["Close tab"],
            keep_clear=1,
        )
        == []
    )


def test_grade_the_old_plain_shell_fails():
    # Before #5865: no strip at all on the setup tab.
    problems = setup_tab_problems(variant=None, text="", buttons=[], keep_clear=0)
    assert "the strip variant is None, not 'agent-setup-installed'" in problems
    assert any("'Agent installed'" in p for p in problems)
    assert any("no 'Close tab'" in p for p in problems)
    assert any("0 toast keep-clear zones" in p for p in problems)


def test_grade_the_plain_session_end_strip_on_a_setup_tab_fails():
    # The exec'd shell ended, but the tab shows the generic end strip.
    problems = setup_tab_problems(
        variant="disconnected",
        text="Session ended The session ended normally (exit code 0). Scrollback is kept.",
        buttons=["Reconnect", "View scrollback"],
        keep_clear=1,
    )
    assert any("plain session end: 'Session ended'" in p for p in problems)
    assert any("offers 'Reconnect'" in p for p in problems)


def test_grade_a_failed_setup_needs_the_failed_variant():
    failed = "Agent setup failed The output below says what went wrong. The setup script exited with code 1."
    assert (
        setup_tab_problems(
            variant="agent-setup-failed", text=failed, buttons=["Close tab"], outcome="failed"
        )
        == []
    )
    # A failure must never read as installed.
    assert setup_tab_problems(variant="agent-setup-failed", text=failed, buttons=["Close tab"])


def test_grade_a_windows_setup_still_being_checked_has_no_outcome():
    # A Windows exit code 0 says nothing: the host is checked first (#5992).
    text = "Checking the agent… The setup ended. termiHub is checking whether the agent was installed."
    for outcome in ("installed", "failed", "unknown"):
        problems = setup_tab_problems(
            variant="agent-setup-checking", text=text, buttons=["Close tab"], outcome=outcome
        )
        assert "the setup tab is still checking the agent, it has no outcome yet" in problems
    assert (
        setup_tab_problems(
            variant="agent-setup-checking", text=text, buttons=["Close tab"], outcome="checking"
        )
        == []
    )


def test_grade_an_unknown_outcome_is_neither_installed_nor_failed():
    text = "Agent setup outcome unknown Check the output below. Checking the installed agent timed out."
    unknown = {"variant": "agent-setup-unknown", "text": text, "buttons": ["Close tab"]}
    assert setup_tab_problems(**unknown, outcome="unknown") == []
    assert setup_tab_problems(**unknown, outcome="installed")
    assert setup_tab_problems(**unknown, outcome="failed")


def test_grade_every_outcome_has_a_heading():
    assert set(HEADINGS) == {"installed", "failed", "cancelled", "checking", "unknown"}


def test_grade_keep_clear_is_optional_when_not_measured():
    assert (
        setup_tab_problems(
            variant="agent-setup-installed", text=INSTALLED_TEXT, buttons=["Close tab"]
        )
        == []
    )


def test_grade_the_strip_sits_at_the_pane_top_over_a_pushed_down_terminal():
    pane = _rect(490, 160, 1500, 1040)
    strip = _rect(490, 160, 1500, 44)
    assert strip_layout_problems(strip=strip, pane=pane, terminal=_rect(490, 204, 1500, 996)) == []
    assert strip_layout_problems(strip=strip, pane=pane, terminal=pane)
