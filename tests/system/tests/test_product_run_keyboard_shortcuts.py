"""The product run's keyboard-shortcut editing grade (#5842), without an app.

Each row of Settings ▸ Keyboard shortcuts shows a visible "Change" on its
binding and the plain "Default" marker while unchanged; recording a new chord
turns the marker into "Reset to default"; Escape (or Cancel) leaves the binding
alone; a taken chord names its owner and offers Cancel · Reassign; a plain
function key on an action that fires in terminals is refused; clearing offers
Undo; and the two "Show keyboard shortcuts" rows say where each one works.
The live drive runs in the desktop phase's keyboard step; this file runs in
the normal (per-PR) lane.
"""

from __future__ import annotations

import copy

from termihub_harness.product_run.keyboard_shortcuts import (
    CONFLICT_OWNER_LABEL,
    HELP_PAIR,
    RECORD_ACTION,
    SAMPLE_ROWS,
    keyboard_shortcut_problems,
)


def _row(action):
    return {
        "action": action,
        "exists": True,
        "change_text": "Change",
        "marker": {"kind": "default", "text": "Default", "border": "0px",
                   "background": "rgba(0, 0, 0, 0)"},
    }


def _good():
    return {
        "rows": [_row(a) for a in SAMPLE_ROWS],
        "labels": {
            "show-shortcuts": "Show keyboard shortcuts (also from terminal)",
            "show-shortcuts-outside-terminal": "Show keyboard shortcuts (not from terminal)",
        },
        "record": {"before": "Ctrl+B", "after": "Ctrl+Alt+J", "reset_text": "Reset to default"},
        "cancel": {"before": "Ctrl+B", "after": "Ctrl+B", "cancel_button": True},
        "conflict": {
            "text": f'"Ctrl+Tab" is already used by "{CONFLICT_OWNER_LABEL}". Reassign it …',
            "reassign": True,
            "cancel": True,
        },
        "function_key": {
            "text": "F5 on its own stays with terminal programs such as Midnight Commander",
            "reassign": False,
            "cancel": False,
            "after": "Ctrl+B",
        },
        "undo": {"toast": True, "undo_button": True, "restored": "Ctrl+B"},
    }


def _with(**changes):
    m = copy.deepcopy(_good())
    for key, value in changes.items():
        m[key] = value
    return m


def test_the_grade_samples_the_issue_rows():
    assert RECORD_ACTION in SAMPLE_ROWS
    assert set(HELP_PAIR) == {"show-shortcuts", "show-shortcuts-outside-terminal"}


def test_a_good_page_passes():
    assert keyboard_shortcut_problems(_good()) == []


def test_nothing_measured_passes():
    assert keyboard_shortcut_problems({}) == []


def test_a_row_without_a_visible_change_fails():
    # R-053: only a silent "×", no edit affordance.
    m = _good()
    m["rows"][0]["change_text"] = None
    assert any("no visible 'Change'" in p for p in keyboard_shortcut_problems(m))


def test_a_pill_default_marker_fails():
    m = _good()
    m["rows"][1]["marker"]["border"] = "1px"
    assert any("has a border" in p for p in keyboard_shortcut_problems(m))


def test_a_reset_on_an_unchanged_row_fails():
    m = _good()
    m["rows"][2]["marker"] = {"kind": "reset", "text": "Reset to default"}
    assert any("unchanged row offers" in p for p in keyboard_shortcut_problems(m))


def test_near_duplicate_help_labels_fail():
    # R-137: "Show keyboard shortcuts" vs "… outside terminals".
    m = _with(labels={
        "show-shortcuts": "Show keyboard shortcuts",
        "show-shortcuts-outside-terminal": "Show keyboard shortcuts outside terminals",
    })
    problems = keyboard_shortcut_problems(m)
    assert any("near-duplicates" in p for p in problems)
    assert any("does not say where it works" in p for p in problems)


def test_a_recording_that_changes_nothing_fails():
    m = _good()
    m["record"]["after"] = "Ctrl+B"
    assert any("recording did not change" in p for p in keyboard_shortcut_problems(m))


def test_a_changed_row_without_reset_fails():
    m = _good()
    m["record"]["reset_text"] = None
    assert any("want 'Reset to default'" in p for p in keyboard_shortcut_problems(m))


def test_escape_that_rebinds_fails():
    m = _good()
    m["cancel"]["after"] = "Escape"
    assert any("Escape changed the binding" in p for p in keyboard_shortcut_problems(m))


def test_no_cancel_button_while_recording_fails():
    m = _good()
    m["cancel"]["cancel_button"] = False
    assert "no visible Cancel while recording" in keyboard_shortcut_problems(m)


def test_a_conflict_without_resolution_fails():
    m = _good()
    m["conflict"]["reassign"] = False
    assert "a conflict offers no Cancel · Reassign" in keyboard_shortcut_problems(m)


def test_a_conflict_that_does_not_name_its_owner_fails():
    m = _good()
    m["conflict"]["text"] = "Shortcut already in use."
    assert any("does not name the action" in p for p in keyboard_shortcut_problems(m))


def test_a_stored_plain_function_key_fails():
    m = _good()
    m["function_key"] = {"text": None, "reassign": False, "cancel": False, "after": "F5"}
    problems = keyboard_shortcut_problems(m)
    assert any("not refused for terminals" in p for p in problems)
    assert "a plain F5 was stored on a global action" in problems


def test_a_clear_without_undo_fails():
    m = _good()
    m["undo"] = {"toast": False, "undo_button": False, "restored": "(unbound)"}
    assert "clearing a shortcut offers no Undo" in keyboard_shortcut_problems(m)


def test_an_undo_that_does_not_restore_fails():
    m = _good()
    m["undo"]["restored"] = "(unbound)"
    assert any("Undo restored" in p for p in keyboard_shortcut_problems(m))
