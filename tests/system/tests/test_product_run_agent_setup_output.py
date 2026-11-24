"""The product run's agent-setup output grade (#5822), without an app.

The setup terminal printed raw octal escapes (``\\360\\237\\232\\200 === termiHub
Agent Setup ===``) because the script passed them to ``echo`` (R-002), and
showed ``rm -f``/``rmdir`` cleanup commands as its main content (R-057). The
live ``agent.setup.terminal-lifecycle`` step applies this grade to the real
setup tab; these tests pin the grade itself and run in the normal (per-PR)
lane. The product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.grades import OCTAL_ESCAPE, setup_output_problems

#: The setup tab as it reads after #5822 (CRLF, as a PTY writes it).
GOOD = (
    "$ sh '/home/me/.config/termihub-agent/updates/upload.Ab12Cd/setup.sh'\r\n"
    "\r\n=== termiHub Agent Setup ===\r\n\r\n"
    "[..] Checking the uploaded agent binary\r\n"
    "[ok] Agent binary uploaded\r\n"
    "[..] Install path: /home/me/.local/bin/termihub-agent\r\n"
    "[..] Checking write access to /home/me/.local/bin\r\n"
    "[ok] /home/me/.local/bin is writable\r\n"
    "[..] Installing the agent to /home/me/.local/bin/termihub-agent\r\n"
    "[..] Verifying the installed agent\r\n"
    "[ok] termihub-agent 0.1.0\r\n\r\n"
    "Agent installed (v0.1.0) at /home/me/.local/bin/termihub-agent. "
    "You can close this tab.\r\n$ "
)

#: The setup tab as run 20261123T215628Z captured it (before #5822).
BEFORE = (
    "$ sh '/home/me/.config/termihub-agent/updates/upload.Ab12Cd/setup.sh'; "
    "rm -f '/home/me/.config/termihub-agent/updates/upload.Ab12Cd/setup.sh'; "
    "rmdir '/home/me/.config/termihub-agent/updates/upload.Ab12Cd' 2>/dev/null\r\n"
    "\\360\\237\\232\\200 === termiHub Agent Setup ===\r\n"
    "\\360\\237\\223\\201 Install path: /home/me/.local/bin/termihub-agent\r\n"
    "\\360\\237\\224\\221 Checking permissions for /home/me/.local/bin... writable \\342\\234\\223\r\n"
    "\\360\\237\\216\\211 === Setup Complete ===\r\n\r\n"
    "You can close this terminal tab now.\r\n$ "
)


def test_the_octal_pattern_matches_a_raw_escape_only():
    assert OCTAL_ESCAPE.search("\\360\\237\\232\\200 ===")
    assert not OCTAL_ESCAPE.search("[ok] termihub-agent 0.1.0")
    # An expanded emoji is not a raw escape.
    assert not OCTAL_ESCAPE.search("\U0001f680 === termiHub Agent Setup ===")


def test_a_plain_successful_setup_passes():
    assert setup_output_problems(GOOD) == []


def test_a_dev_build_version_with_its_branch_passes():
    # A dev build reports "0.1.0 (branch: develop)" (run 20261124T080801Z).
    dev = GOOD.replace("(v0.1.0)", "(v0.1.0 (branch: develop))")
    assert setup_output_problems(dev) == []


def test_the_run_before_the_fix_is_named_on_every_count():
    problems = setup_output_problems(BEFORE)
    assert problems[0] == "raw octal escape '\\\\360' in the setup output"
    assert any(p.startswith("shell cleanup commands in the setup output") for p in problems)
    assert "no 'Agent installed (v<x>) at <path>.' summary line" in problems
    assert len(problems) == 3


def test_a_failure_line_on_a_success_run_is_named():
    failed = GOOD + "\r\nAgent setup failed: a setup step exited with status 1 (see above).\r\n"
    assert setup_output_problems(failed) == [
        "the setup reports a failure: "
        "'Agent setup failed: a setup step exited with status 1 (see above).'"
    ]


def test_an_expected_failure_needs_its_summary_line():
    failed = (
        "[error] The agent binary was not uploaded.\r\n        Run the setup again.\r\n\r\n"
        "Agent setup failed: The agent binary was not uploaded.\r\n"
    )
    assert setup_output_problems(failed, expect_success=False) == []
    assert setup_output_problems("[error] boom\r\n", expect_success=False) == [
        "no 'Agent setup failed: <reason>' summary line"
    ]


def test_an_installed_line_without_a_version_does_not_count():
    unversioned = GOOD.replace("(v0.1.0)", "(v)")
    assert setup_output_problems(unversioned) == [
        "no 'Agent installed (v<x>) at <path>.' summary line"
    ]
