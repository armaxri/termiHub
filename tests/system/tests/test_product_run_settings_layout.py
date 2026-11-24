"""The product run's shared settings layout grade (#5843), without an app.

Compact number inputs with units, a plain "Default" marker that is not a pill
(a labelled "Reset to default" button once overridden), one-line hints, a
secondary "Clear all history", and one centred page width for the search bar,
nav and content. The live measurement runs in the desktop phase's settings
layout step; this file runs in the normal (per-PR) lane.
"""

from __future__ import annotations

from termihub_harness.product_run.settings_layout import (
    CLEAR_BUTTONS,
    HINTS,
    MAX_NUMBER_INPUT_WIDTH,
    NUMERIC_FIELDS,
    PAGE_MAX_WIDTH,
    merge_measurements,
    settings_layout_problems,
)


def _box(x, width, y=0.0, height=30.0):
    return {"x": x, "y": y, "width": width, "height": height}


def _page(panel_width=1400.0, frame_width=PAGE_MAX_WIDTH):
    left = (panel_width - frame_width) / 2
    return {
        "panel": _box(0.0, panel_width, height=800.0),
        "search": _box(left, frame_width),
        "body": _box(left, frame_width, y=40.0, height=760.0),
    }


def _good():
    return {
        "numbers": [
            {"label": "Font size", "width": 76.0, "unit": "px"},
            {"label": "Line height", "width": 76.0, "unit": None},
            {"label": "Scrollback buffer", "width": 98.0, "unit": "lines"},
            {"label": "Session history limit", "width": 76.0, "unit": "sessions"},
        ],
        "markers": [
            {"label": "Font size", "kind": "default", "border": "0px",
             "background": "rgba(0, 0, 0, 0)", "text": "Default"},
            {"label": "Scrollback buffer", "kind": "reset", "type": "button",
             "text": "Reset to default"},
        ],
        "hints": [{"testId": "settings-font-size-hint", "height": 15.0, "line_height": 15.4}],
        "clear_buttons": [
            {"testId": b, "classes": ["ui-btn", "ui-btn--secondary"]} for b in CLEAR_BUTTONS
        ],
        "pages": [_page()],
    }


def test_the_graded_fields_cover_the_issue_surfaces():
    labels = {label for _c, _i, _m, label, _u in NUMERIC_FIELDS}
    assert {"Font size", "Line height", "Scrollback buffer", "Session history limit"} <= labels
    assert {"appearance", "terminal", "sessions"} <= set(HINTS)
    assert "settings-network-tool-history-hint" in HINTS["sessions"]


def test_a_good_layout_passes():
    assert settings_layout_problems(_good()) == []


def test_nothing_measured_passes():
    assert settings_layout_problems({}) == []


def test_a_full_width_number_input_fails():
    # R-128: a 900 px input for a 2-digit font size.
    m = _good()
    m["numbers"][0]["width"] = 900.0
    problems = settings_layout_problems(m)
    assert any("Font size" in p and f"> {MAX_NUMBER_INPUT_WIDTH:.0f}px" in p for p in problems)


def test_a_missing_unit_fails():
    m = _good()
    m["numbers"][2]["unit"] = None
    assert "Scrollback buffer: unit None, want 'lines'" in settings_layout_problems(m)


def test_a_bordered_default_pill_fails():
    # R-044: the Default tag drawn as a bordered pill.
    m = _good()
    m["markers"][0]["border"] = "1px"
    assert any("has a border" in p for p in settings_layout_problems(m))


def test_a_filled_default_marker_fails():
    m = _good()
    m["markers"][0]["background"] = "rgb(40, 44, 52)"
    assert any("has a fill" in p for p in settings_layout_problems(m))


def test_a_reset_that_is_not_a_button_fails():
    m = _good()
    m["markers"][1]["type"] = None
    assert any("the reset is not a button" in p for p in settings_layout_problems(m))


def test_an_unlabelled_reset_fails():
    m = _good()
    m["markers"][1]["text"] = ""
    assert any("the reset button reads" in p for p in settings_layout_problems(m))


def test_a_paragraph_hint_fails():
    # R-139: five lines for network tool history.
    m = _good()
    m["hints"].append(
        {"testId": "settings-network-tool-history-hint", "height": 77.0, "line_height": 15.4}
    )
    assert any("wraps to 5.0 lines" in p for p in settings_layout_problems(m))


def test_a_danger_clear_button_fails():
    m = _good()
    m["clear_buttons"][0]["classes"] = ["ui-btn", "ui-btn--danger"]
    assert any("danger skin" in p for p in settings_layout_problems(m))


def test_content_floating_left_on_a_wide_window_fails():
    # R-153: nav and search full width, content capped and floating left.
    m = _good()
    m["pages"] = [{
        "panel": _box(0.0, 1400.0, height=800.0),
        "search": _box(0.0, 1400.0),
        "body": _box(0.0, 1400.0, y=40.0),
    }]
    problems = settings_layout_problems(m)
    assert any("search bar is 1400px wide" in p for p in problems)
    assert any("settings body is 1400px wide" in p for p in problems)


def test_an_off_centre_frame_fails():
    m = _good()
    page = _page()
    page["body"]["x"] = 0.0
    page["search"]["x"] = 0.0
    m["pages"] = [page]
    assert any("not centred" in p for p in settings_layout_problems(m))


def test_a_narrow_panel_fills_its_width():
    m = _good()
    m["pages"] = [_page(panel_width=700.0, frame_width=700.0)]
    assert settings_layout_problems(m) == []


def test_merge_concatenates_pages():
    a = {**_page(), "numbers": [{"label": "Font size", "width": 76.0, "unit": "px"}]}
    b = {**_page(), "hints": [{"testId": "x", "height": 15.0, "line_height": 15.0}]}
    merged = merge_measurements([a, b])
    assert len(merged["numbers"]) == 1 and len(merged["hints"]) == 1
    assert len(merged["pages"]) == 2
    assert settings_layout_problems(merged) == []
