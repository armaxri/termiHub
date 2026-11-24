"""The product run's Settings ▸ Open in termiHub + offer grade (#5845), without an app.

One vocabulary for the "Open in termiHub" file-manager entry: the nav item and
page title say "Open in termiHub", the status and its button name the same place
("Not added to Finder" / "Add to Finder"), the reorder hint waits for two
entries, the no-match setting reads "When opening a folder", and the nav icon
keeps its size. The offer toast puts its primary "Add to …" next to "Not now",
uses "▸", and "Not now" says where to find it later. The live measurements run
in the desktop phase (the page) and the file-manager offer phase (the toast);
this file runs in the normal (per-PR) lane.
"""

from __future__ import annotations

import pytest

from termihub_harness.product_run.file_manager_settings import (
    MAX_BUTTON_GAP,
    SETTINGS_PATH,
    TITLE,
    file_manager_page_problems,
    later_note_problems,
    offer_problems,
    place_for,
)
from termihub_harness.product_run.grades import is_sentence_case

PLACE = "Finder"


def _page(**overrides):
    m = {
        "nav_label": TITLE,
        "nav_icon": {"x": 10.0, "y": 0.0, "width": 16.0, "height": 16.0},
        "section_text": "Open in termiHub Adds “Open in termiHub” to the right-click menu in "
        "Finder. Not added to Finder Add to Finder Quick-access entries No quick-access "
        "entries yet. When opening a folder Ask which session",
        "status": "Not added to Finder",
        "registered": "false",
        "primary": "Add to Finder",
        "remove": None,
        "entries": 0,
        "entries_empty": True,
        "entries_hint": None,
        "fallback_label": "When opening a folder",
    }
    m.update(overrides)
    return m


def _offer(**overrides):
    m = {
        "text": "Add “Open in termiHub” to Finder? Right-click any folder in Finder to open it "
        f"in termiHub. You can also add it later in {SETTINGS_PATH}. Not now Add to Finder",
        "add": "Add to Finder",
        "not_now": "Not now",
        "not_now_rect": {"x": 200.0, "y": 80.0, "width": 60.0, "height": 24.0},
        "add_rect": {"x": 268.0, "y": 80.0, "width": 90.0, "height": 24.0},
        "add_background": "rgb(0, 122, 204)",
        "not_now_background": "rgba(0, 0, 0, 0)",
    }
    m.update(overrides)
    return m


@pytest.mark.parametrize(
    ("platform", "place"),
    [("darwin", "Finder"), ("win32", "File Explorer"), ("linux", "your file manager")],
)
def test_the_place_follows_the_platform(platform, place):
    assert place_for(platform) == place


def test_the_title_is_sentence_case():
    # The Settings nav grade checks every category label is sentence case.
    assert is_sentence_case(TITLE)


def test_a_plain_page_passes():
    assert file_manager_page_problems(_page(), PLACE) == []


def test_nothing_measured_passes():
    assert file_manager_page_problems({}, PLACE) == []


def test_a_registered_page_passes():
    m = _page(
        registered="true",
        status="Added to Finder",
        primary="Update",
        remove="Remove from Finder",
    )
    assert file_manager_page_problems(m, PLACE) == []


def test_the_old_vocabulary_fails():
    # R-032: 'Not registered' beside 'Install'.
    m = _page(status="Not registered", primary="Install")
    problems = file_manager_page_problems(m, PLACE)
    assert "status reads 'Not registered', want 'Not added to Finder'" in problems
    assert "the primary button reads 'Install', want 'Add to Finder'" in problems


def test_the_old_nav_label_fails():
    m = _page(nav_label="File manager integration")
    assert any("the nav item reads" in p for p in file_manager_page_problems(m, PLACE))


def test_a_dot_icon_fails():
    # R-105 / R-138: the icon shrank to a dot beside the long label.
    m = _page(nav_icon={"x": 10.0, "y": 0.0, "width": 4.0, "height": 16.0})
    assert any("a dot" in p for p in file_manager_page_problems(m, PLACE))


def test_a_missing_icon_fails():
    assert "the nav item has no icon" in file_manager_page_problems(_page(nav_icon=None), PLACE)


def test_the_reorder_hint_on_an_empty_list_fails():
    # R-032: "drag the handle or arrow buttons" while the list is empty.
    m = _page(entries_hint="Drag the handle or use the arrow buttons to reorder.")
    assert any("reorder hint shows with 0" in p for p in file_manager_page_problems(m, PLACE))


def test_the_reorder_hint_with_two_entries_passes():
    m = _page(
        entries=2,
        entries_empty=False,
        entries_hint="Drag the handle or use the arrow buttons to reorder. The first “Always” "
        "entry is the default.",
    )
    assert file_manager_page_problems(m, PLACE) == []


def test_a_missing_reorder_hint_with_two_entries_fails():
    m = _page(
        entries=2, entries_empty=False, entries_hint="The first “Always” entry is the default."
    )
    assert "the reorder hint is missing with 2+ entries" in file_manager_page_problems(m, PLACE)


def test_the_fallback_jargon_fails():
    m = _page(
        fallback_label="Fallback when no entry matches",
        section_text=_page()["section_text"] + " Fallback when no entry matches",
    )
    problems = file_manager_page_problems(m, PLACE)
    assert any("no-match setting reads" in p for p in problems)
    assert "the page still says 'Fallback'" in problems


def test_a_plain_offer_passes():
    assert offer_problems(_offer(), PLACE) == []


def test_the_old_offer_fails():
    # R-035: 'Install' far right, unstyled, and '›' as separator.
    m = _offer(
        text="Add “Open in termiHub” to your file manager? You can also do this later in "
        "Settings › File manager integration.",
        add="Install",
        add_rect={"x": 600.0, "y": 80.0, "width": 50.0, "height": 24.0},
        add_background="rgba(0, 0, 0, 0)",
    )
    problems = offer_problems(m, PLACE)
    assert any("does not name 'Finder'" in p for p in problems)
    assert "the primary reads 'Install', want 'Add to Finder'" in problems
    assert any("'›' as path separator" in p for p in problems)
    assert any(f"> {MAX_BUTTON_GAP:.0f}px" in p for p in problems)
    assert "the add button is not styled as the primary (no fill)" in problems


def test_a_primary_left_of_not_now_fails():
    m = _offer(add_rect={"x": 100.0, "y": 80.0, "width": 90.0, "height": 24.0})
    assert "the primary button is not to the right of Not now" in offer_problems(m, PLACE)


def test_buttons_on_two_rows_fail():
    m = _offer(add_rect={"x": 268.0, "y": 110.0, "width": 90.0, "height": 24.0})
    assert "Not now and the primary are not on one row" in offer_problems(m, PLACE)


def test_a_missing_button_fails():
    assert "the offer is missing a button" in offer_problems(_offer(add_rect=None), PLACE)


def test_the_later_note_must_point_at_settings():
    # R-108: after Not now nothing said where to find it again.
    assert later_note_problems(f"You can add it any time in {SETTINGS_PATH}.") == []
    assert later_note_problems(None) == ["nothing says where to find the offer after Not now"]
    assert later_note_problems("Maybe later.") != []
