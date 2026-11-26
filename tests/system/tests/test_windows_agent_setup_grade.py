"""Grading an agent the suites deployed through the app's setup (#5533).

On the Windows native sshd the deployed-agent suites install the agent the way
a user does, through the agent's Setup, instead of writing ``agentPath``
themselves: the setup tab must end installed, and the app must have stored the
managed install path. App-free, in the normal lane.
"""

from __future__ import annotations

from termihub_harness.ui.agent import setup_tab_end, windows_setup_problems

MANAGED = "C:/Users/termihub-test/AppData/Local/termiHub/agent/termihub-agent.exe"


def test_an_installed_setup_that_stored_the_managed_path_passes():
    assert windows_setup_problems("agent-setup-installed", MANAGED, MANAGED) == []


def test_a_failed_or_unfinished_setup_fails():
    assert windows_setup_problems("agent-setup-failed", MANAGED, MANAGED) == [
        "the setup ended 'agent-setup-failed', not installed"
    ]
    assert windows_setup_problems(None, MANAGED, MANAGED) == [
        "the setup ended None, not installed"
    ]


def test_a_path_the_app_did_not_store_fails():
    assert windows_setup_problems("agent-setup-installed", None, MANAGED) == [
        f"the app stored agentPath None, not the managed install path {MANAGED!r}"
    ]
    other = "~/.local/bin/termihub-agent"
    assert windows_setup_problems("agent-setup-installed", other, MANAGED) == [
        f"the app stored agentPath {other!r}, not the managed install path {MANAGED!r}"
    ]


def test_the_path_compares_without_case_or_slash_spelling():
    assert windows_setup_problems("agent-setup-installed", MANAGED.upper(), MANAGED) == []
    assert (
        windows_setup_problems("agent-setup-installed", MANAGED.replace("/", "\\"), MANAGED)
        == []
    )


def test_the_checking_strip_is_not_an_end():
    # The strip reads "checking" between the shell's end and the host check's
    # outcome; the nightly read that as the end and failed every setup.
    assert setup_tab_end("agent-setup-checking") is None
    assert setup_tab_end(None) is None
    for variant in ("agent-setup-installed", "agent-setup-failed", "agent-setup-unknown"):
        assert setup_tab_end(variant) == variant
