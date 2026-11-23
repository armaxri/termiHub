"""The product run's tunnel-editor primary-action grade (#5810), without an app.

A new tunnel's primary (filled, right-most) footer action is Save and start;
editing an existing tunnel keeps Save primary. Runs in the normal (per-PR)
lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.grades import (
    TUNNEL_EDITOR_SAVE,
    TUNNEL_EDITOR_SAVE_START,
    tunnel_editor_primary_problems,
)

CANCEL = "tunnel-editor-cancel"


def _button(test_id, x, primary=False, width=90.0):
    return {"testId": test_id, "rect": {"x": x, "y": 900, "width": width, "height": 30}, "primary": primary}


def _new_footer():
    return [
        _button(CANCEL, 300),
        _button(TUNNEL_EDITOR_SAVE, 400),
        _button(TUNNEL_EDITOR_SAVE_START, 500, primary=True, width=120),
    ]


def _edit_footer():
    return [
        _button(CANCEL, 300),
        _button(TUNNEL_EDITOR_SAVE_START, 400, width=120),
        _button(TUNNEL_EDITOR_SAVE, 530, primary=True),
    ]


def test_new_tunnel_with_save_and_start_primary_passes():
    assert tunnel_editor_primary_problems(_new_footer(), editing=False) == []


def test_editing_with_save_primary_passes():
    assert tunnel_editor_primary_problems(_edit_footer(), editing=True) == []


def test_new_tunnel_with_save_primary_fails():
    problems = tunnel_editor_primary_problems(_edit_footer(), editing=False)
    assert any("a new tunnel: primary is" in p for p in problems), problems
    assert any("right-most" in p for p in problems), problems


def test_editing_with_save_and_start_primary_fails():
    problems = tunnel_editor_primary_problems(_new_footer(), editing=True)
    assert any("editing: primary is" in p for p in problems), problems


def test_two_primaries_fail():
    buttons = _new_footer()
    buttons[1]["primary"] = True
    assert any("primary is" in p for p in tunnel_editor_primary_problems(buttons, editing=False))


def test_no_primary_fails():
    buttons = [dict(b, primary=False) for b in _new_footer()]
    assert any("none" in p for p in tunnel_editor_primary_problems(buttons, editing=False))


def test_primary_not_right_most_fails():
    buttons = _new_footer()
    buttons[2]["rect"]["x"] = 200
    problems = tunnel_editor_primary_problems(buttons, editing=False)
    assert any("right-most" in p for p in problems), problems
    assert not any("primary is" in p for p in problems), problems
