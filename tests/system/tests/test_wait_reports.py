"""Machinery tests: a wait that times out says what it was looking at (#6046)."""

from __future__ import annotations

import pytest

from termihub_harness.ui.terminal import TerminalUi, terminal_tail

from test_transfer_queue import TransferQueueReads


class _Driver:
    def __init__(self, text):
        self.text = text

    def read_terminal(self, _tab_id=None):
        return self.text


def _wait(predicate, *, timeout, what, interval=0.0):
    result = predicate()
    if result:
        return result
    raise AssertionError(f"timed out waiting for {what} (last error: None)")


def _terminal(text):
    ui = TerminalUi()
    ui.driver = _Driver(text)
    ui.wait = _wait
    return ui


def test_output_that_comes_is_returned():
    assert _terminal("$ echo hi\nhi\n").wait_for_output("hi") == "$ echo hi\nhi\n"


def test_output_that_does_not_come_shows_the_terminal():
    ui = _terminal("$ sync\n\n   \n$ wc -c < x\nbash: x: Device or resource busy\n")
    with pytest.raises(AssertionError) as caught:
        ui.wait_for_output("SIZE:8:")
    first, *rest = str(caught.value).splitlines()
    # The first line is what the timing and rerun reports group by.
    assert first == "timed out waiting for 'SIZE:8:' in terminal output (last error: None)"
    assert rest == [
        "the terminal shows:",
        "  | $ sync",
        "  | $ wc -c < x",
        "  | bash: x: Device or resource busy",
    ]


def test_the_tail_is_short_and_never_empty():
    assert terminal_tail("\n".join(str(i) for i in range(40))).splitlines()[0] == "  | 25"
    assert terminal_tail("\n \n") == "  | (nothing)"


class _Queue(TransferQueueReads):
    def __init__(self, rows):
        self.rows = rows
        self.wait = _wait

    def queue_entries(self):
        return self.rows


def test_a_queue_wait_shows_the_rows():
    row = {"id": "t", "state": "failed", "error": "create failed"}
    with pytest.raises(AssertionError, match="timed out waiting for the paste") as caught:
        _Queue([row]).wait_for_queue(lambda rows: False, what="the paste to complete")
    assert "the transfer queue holds:" in str(caught.value)
    assert "create failed" in str(caught.value)
    with pytest.raises(AssertionError, match=r"\(no rows\)"):
        _Queue([]).wait_for_queue_size(1)
    assert _Queue([row]).wait_for_queue_size(1) == [row]
