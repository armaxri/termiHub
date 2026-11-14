"""The product run's connection-editor primary-action grade (#5755), without an app.

A new connection's primary (filled, right-most) footer action is Save and
connect; editing an existing connection keeps Save primary. Runs in the normal
(per-PR) lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.grades import (
    EDITOR_SAVE,
    EDITOR_SAVE_CONNECT,
    editor_primary_problems,
)

CANCEL = "connection-editor-cancel"
TEST = "connection-editor-test"


def _button(test_id, x, primary=False, width=90.0):
    return {"testId": test_id, "rect": {"x": x, "y": 900, "width": width, "height": 30}, "primary": primary}


def _new_footer():
    return [
        _button(CANCEL, 300),
        _button(TEST, 400),
        _button(EDITOR_SAVE, 500),
        _button(EDITOR_SAVE_CONNECT, 600, primary=True, width=130),
    ]


def _edit_footer():
    return [
        _button(CANCEL, 300),
        _button(TEST, 400),
        _button(EDITOR_SAVE_CONNECT, 500, width=130),
        _button(EDITOR_SAVE, 640, primary=True),
    ]


def test_new_connection_with_save_and_connect_primary_passes():
    assert editor_primary_problems(_new_footer(), editing=False) == []


def test_editing_with_save_primary_passes():
    assert editor_primary_problems(_edit_footer(), editing=True) == []


def test_new_connection_with_save_primary_fails():
    problems = editor_primary_problems(_edit_footer(), editing=False)
    assert any("primary is" in p for p in problems), problems
    assert any("right-most" in p for p in problems), problems


def test_editing_with_save_and_connect_primary_fails():
    problems = editor_primary_problems(_new_footer(), editing=True)
    assert any("primary is" in p for p in problems), problems


def test_two_primaries_fail():
    buttons = _new_footer()
    buttons[2]["primary"] = True
    assert any("primary is" in p for p in editor_primary_problems(buttons, editing=False))


def test_no_primary_fails():
    buttons = [dict(b, primary=False) for b in _new_footer()]
    assert any("none" in p for p in editor_primary_problems(buttons, editing=False))


def test_primary_not_right_most_fails():
    buttons = _new_footer()
    buttons[3]["rect"]["x"] = 200
    problems = editor_primary_problems(buttons, editing=False)
    assert any("right-most" in p for p in problems), problems
    assert not any("primary is" in p for p in problems), problems
