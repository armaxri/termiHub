"""The product run's host-key layout grades (#5662), without an app.

Runs in the normal (per-PR) lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.hostkey_layout import (
    fingerprint_layout_problems,
    rejected_screen_problems,
)


def _item(text, x, width, height=18.0, *, y=100.0, test_id=None, visible=True):
    return {
        "testId": test_id,
        "text": text,
        "rect": {"x": x, "y": y, "width": width, "height": height},
        "visible": visible,
    }


TYPE_LINE = _item("ssh-ed25519", 20, 80, test_id="ssh-hostkey-type")
COPY = [_item("", 400, 22, 22)]


def test_a_fingerprint_on_one_line_with_a_gap_passes():
    text = [TYPE_LINE, _item("SHA256:", 20, 50), _item("nThbg6kXUpJWGl7E1IGOCsp", 70, 300)]
    assert fingerprint_layout_problems(text, COPY) == []


def test_a_mid_string_break_is_named():
    # The long piece spans two lines: twice the prefix's height.
    text = [_item("SHA256:", 20, 50), _item("nThbg6kXUpJWGl7E1IGOCsp", 20, 360, 36)]
    problems = fingerprint_layout_problems(text, COPY)
    assert problems == ["fingerprint piece 'nThbg6kXUpJWGl7E1IGOCsp' breaks mid-string"]


def test_text_running_into_the_copy_button_is_named():
    text = [_item("SHA256:", 20, 50), _item("nThbg6kXUpJWGl7E1IGOCsp", 70, 328)]
    problems = fingerprint_layout_problems(text, COPY)
    assert len(problems) == 1 and "runs into its copy button" in problems[0]


def test_a_missing_copy_button_or_text_is_named():
    text = [_item("SHA256:", 20, 50), _item("abc", 70, 30)]
    assert fingerprint_layout_problems(text, []) == [
        "no visible copy button beside the fingerprint"
    ]
    assert fingerprint_layout_problems([TYPE_LINE], COPY) == ["no visible fingerprint text"]


HEADING = _item("You rejected the host key", 100, 220)
HINT = _item(
    "Review the key again once its fingerprint is confirmed with the server's administrator,"
    " or edit the connection if the host or port is wrong.",
    100,
    420,
    36,
)
LIVE = _item("You rejected the host key. prod: Review the key again …", 0, 1, 1)


def test_the_rejected_screen_saying_it_once_passes():
    assert rejected_screen_problems([LIVE, HEADING, HINT]) == []


def test_the_rejected_screen_repeating_itself_is_named():
    box = _item("You rejected the host key of db.internal:22, so the connection was not made", 100, 420)
    old_hint = _item("termiHub did not connect because you rejected the server's host key.", 100, 420)
    problems = rejected_screen_problems([HEADING, box, old_hint])
    assert len(problems) == 2
    assert "says it 3 times" in problems[0]
    assert problems[1] == "no one-line hint on what to do next"
