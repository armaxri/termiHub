"""The product run's "is it painted, not just buffered" grade (#5620), without an app.

Runs in the normal (per-PR) lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.grades import painted_terminal_problems

VISIBLE = {"left": 260, "top": 80, "width": 600, "height": 400}


def _measure(**over):
    base = {"slotted": True, "visibleRect": VISIBLE, "domRows": None}
    base.update(over)
    return base


def test_webgl_terminal_in_its_slot_with_the_lines_passes():
    rows = ["PR-DEVICE READY", "[Process exited]", "ID?", "PR-SERIAL-DEVICE v1"]
    assert painted_terminal_problems(_measure(), rows, ["PR-DEVICE READY", "PR-SERIAL-DEVICE v1"]) == []


def test_parked_terminal_fails_although_the_buffer_has_the_lines():
    # The #5620 shape: full buffer, element never adopted into the slot.
    problems = painted_terminal_problems(
        _measure(slotted=False, visibleRect={"left": 0, "top": 0, "width": 0, "height": 0}),
        ["PR_SSH_JUMP_OK", "PR_SSH_AUTO_RECONNECT_OK"],
        ["PR_SSH_AUTO_RECONNECT_OK"],
    )
    assert any("parked" in p for p in problems), problems
    assert any("visible area" in p for p in problems), problems


def test_dom_renderer_grades_the_painted_rows_not_the_viewport():
    problems = painted_terminal_problems(
        _measure(domRows=["", ""]), ["PR_SSH_AUTO_RECONNECT_OK"], ["PR_SSH_AUTO_RECONNECT_OK"]
    )
    assert problems == ["not on the painted DOM rows: ['PR_SSH_AUTO_RECONNECT_OK']"]


def test_missing_line_on_the_viewport_is_named():
    problems = painted_terminal_problems(_measure(), ["$ "], ["PR-DEVICE READY"])
    assert problems == ["not on the viewport rows: ['PR-DEVICE READY']"]


def test_an_app_without_the_slotted_field_is_not_failed_for_it():
    measure = _measure()
    del measure["slotted"]
    assert painted_terminal_problems(measure, ["ok"], ["ok"]) == []
