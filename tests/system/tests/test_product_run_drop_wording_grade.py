"""The product run's drop-wording grades (#5619, #5660), without an app.

Runs in the normal (per-PR) lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.grades import (
    drop_separator_problems,
    reconnect_wording_problems,
)

RECONNECTED = "$ echo hi\r\nhi\r\n— connection lost 09:05:07 —\r\n— reconnected 09:05:12 —\r\n$ "


def test_a_marked_network_drop_and_reconnect_passes():
    assert drop_separator_problems(RECONNECTED, "network") == []


def test_process_exited_for_a_drop_is_named():
    buffer = RECONNECTED.replace("— connection lost 09:05:07 —", "[Process exited]")
    problems = drop_separator_problems(buffer, "network")
    assert any("[Process exited]" in p for p in problems)
    assert any("network drop separator" in p for p in problems)


def test_a_missing_reconnect_marker_is_named():
    buffer = "PR-DEVICE READY\r\n— device disconnected 10:00:00 —\r\n"
    assert drop_separator_problems(buffer, "serial", reconnected=False) == []
    assert drop_separator_problems(buffer, "serial") == [
        "no '— reconnected hh:mm:ss —' marker after the reconnect"
    ]


def test_the_serial_notice_must_not_mention_a_shell_or_agent():
    good = "Device disconnected — reconnecting… Scrollback is kept. Waiting for /dev/ttys004."
    assert reconnect_wording_problems(good, serial=True) == []
    bad = "Without an agent, the remote shell state is not restored — a fresh shell opens."
    assert len(reconnect_wording_problems(bad, serial=True)) == 2


def test_a_bare_agent_in_an_ssh_notice_is_named():
    assert reconnect_wording_problems("Your remote shell restarts; running programs are lost.") == []
    assert reconnect_wording_problems("Reconnecting to the termiHub remote agent.") == []
    assert reconnect_wording_problems("Without an agent, the remote shell state is not restored.")
