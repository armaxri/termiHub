"""Settings ▸ Open in termiHub and its one-time offer (#5845): measure live, grade without an app.

One plain vocabulary everywhere: the nav item, the page title and the offer call
the feature "Open in termiHub" (the entry the user sees in the right-click
menu), and the status, its button and the offer name the same place — Finder,
File Explorer or "your file manager" (``fileManagerPlace`` in
``src/utils/platform.ts``): "Not added to Finder" beside "Add to Finder". The
reorder hint waits for two entries, the no-match setting reads "When opening a
folder" (not "Fallback…"), and the nav icon keeps its size instead of shrinking
to a dot. The offer toast puts its primary "Add to …" right next to "Not now",
uses the app's ``▸`` path separator, and "Not now" says where to find it later.

:func:`measure_file_manager_page` and :func:`measure_offer` read the live app;
:func:`file_manager_page_problems` and :func:`offer_problems` grade the
measurements and run in the normal (per-PR) lane.
"""

from __future__ import annotations

import sys
from typing import Any, Optional

from ..colors import parse_color

#: The feature's one name: nav item, page title and the Settings path in copy.
TITLE = "Open in termiHub"
#: The Settings path the offer and its "Not now" note point at.
SETTINGS_PATH = f"Settings ▸ {TITLE}"
#: The separator the rest of the app uses; the offer used "›" before #5845.
OLD_SEPARATOR = "›"
#: Jargon the page must not use any more (R-032).
OLD_WORDS = ("Fallback", "Not registered", "Reinstall", "Uninstall", "File manager integration")
#: The nav icon is 16px; below this it reads as a dot (R-105, R-138).
MIN_ICON_SIZE = 14.0
#: Most space allowed between "Not now" and the primary button (R-035).
MAX_BUTTON_GAP = 24.0

NAV = "settings-nav-shell-integration"
NAV_ICON = "settings-category-icon-shell-integration"
SECTION = "settings-shell-integration"
STATUS = "shell-integration-status-text"
PRIMARY = "shell-integration-reinstall"
REMOVE = "shell-integration-uninstall"
ENTRIES_EMPTY = "shell-integration-entries-empty"
ENTRIES_HINT = "shell-integration-entries-hint"
FALLBACK = "shell-integration-fallback"
OFFER = "file-manager-offer"
OFFER_ADD = "file-manager-offer-install"
OFFER_NOT_NOW = "file-manager-offer-not-now"
OFFER_LATER = "file-manager-offer-later"


def place_for(platform: str = sys.platform) -> str:
    """The file manager the copy names on ``platform`` (a ``sys.platform`` value)."""
    if platform == "darwin":
        return "Finder"
    if platform.startswith("win"):
        return "File Explorer"
    return "your file manager"


def _text(driver: Any, test_id: str) -> Optional[str]:
    return driver.get_text(test_id).strip() if driver.exists(test_id) else None


def _rect(driver: Any, test_id: str) -> Optional[dict]:
    return driver.measure_element(test_id)["rect"] if driver.exists(test_id) else None


def measure_file_manager_page(driver: Any, entries: int) -> dict:
    """What the grade reads on the open Settings ▸ Open in termiHub page.

    ``entries`` is the number of quick-access entries in the profile (the caller
    reads it from ``settings.json``), so the grade knows whether the reorder
    hint belongs on the page.
    """
    return {
        "nav_label": _text(driver, NAV),
        "nav_icon": _rect(driver, NAV_ICON),
        "section_text": _text(driver, SECTION) or "",
        "status": _text(driver, STATUS),
        "registered": driver.get_attribute(STATUS, "data-registered")
        if driver.exists(STATUS)
        else None,
        "primary": _text(driver, PRIMARY),
        "remove": _text(driver, REMOVE),
        "entries": entries,
        "entries_empty": driver.exists(ENTRIES_EMPTY),
        "entries_hint": _text(driver, ENTRIES_HINT),
        "fallback_label": driver.get_attribute(FALLBACK, "aria-label")
        if driver.exists(FALLBACK)
        else None,
    }


def _icon_problems(icon: Optional[dict]) -> list[str]:
    if icon is None:
        return ["the nav item has no icon"]
    width, height = float(icon["width"]), float(icon["height"])
    if width < MIN_ICON_SIZE or height < MIN_ICON_SIZE:
        return [f"the nav icon is {width:.0f}x{height:.0f}px (< {MIN_ICON_SIZE:.0f}px, a dot)"]
    return []


def _state_problems(m: dict, place: str) -> list[str]:
    status, primary, remove = m.get("status"), m.get("primary"), m.get("remove")
    if m.get("registered") == "true":
        want = (f"Added to {place}", "Update", f"Remove from {place}")
    else:
        want = (f"Not added to {place}", f"Add to {place}", None)
    problems = []
    if status != want[0]:
        problems.append(f"status reads {status!r}, want {want[0]!r}")
    if primary != want[1]:
        problems.append(f"the primary button reads {primary!r}, want {want[1]!r}")
    if remove != want[2]:
        problems.append(f"the remove button reads {remove!r}, want {want[2]!r}")
    return problems


def _entries_problems(m: dict) -> list[str]:
    entries, hint = int(m.get("entries") or 0), m.get("entries_hint") or ""
    problems = []
    reorder = "reorder" in hint.lower()
    if entries < 2 and reorder:
        noun = "entry" if entries == 1 else "entries"
        problems.append(f"the reorder hint shows with {entries} {noun}")
    if entries >= 2 and not reorder:
        problems.append("the reorder hint is missing with 2+ entries")
    if entries == 0 and not m.get("entries_empty"):
        problems.append("no empty-list note while there are no entries")
    return problems


def file_manager_page_problems(m: dict, place: Optional[str] = None) -> list[str]:
    """Problems with the measured settings page; ``[]`` when it reads plainly."""
    if not m:
        return []
    place = place or place_for()
    problems = []
    if m.get("nav_label") != TITLE:
        problems.append(f"the nav item reads {m.get('nav_label')!r}, want {TITLE!r}")
    problems += _icon_problems(m.get("nav_icon"))
    problems += _state_problems(m, place)
    problems += _entries_problems(m)
    if m.get("fallback_label") != "When opening a folder":
        problems.append(
            f"the no-match setting reads {m.get('fallback_label')!r}, want 'When opening a folder'"
        )
    text = m.get("section_text") or ""
    problems += [f"the page still says {w!r}" for w in OLD_WORDS if w in text]
    return problems


def _style(driver: Any, prop: str, test_id: str) -> Optional[str]:
    return driver.get_computed_style(prop, test_id) if driver.exists(test_id) else None


def measure_offer(driver: Any) -> dict:
    """What the grade reads on the showing offer toast."""
    return {
        "text": _text(driver, OFFER) or "",
        "add": _text(driver, OFFER_ADD),
        "not_now": _text(driver, OFFER_NOT_NOW),
        "add_rect": _rect(driver, OFFER_ADD),
        "not_now_rect": _rect(driver, OFFER_NOT_NOW),
        "add_background": _style(driver, "background-color", OFFER_ADD),
        "not_now_background": _style(driver, "background-color", OFFER_NOT_NOW),
    }


def _filled(color: Optional[str]) -> bool:
    return parse_color(color or "transparent").a > 0


def _button_problems(m: dict) -> list[str]:
    add, not_now = m.get("add_rect"), m.get("not_now_rect")
    if not add or not not_now:
        return ["the offer is missing a button"]
    problems = []
    gap = float(add["x"]) - (float(not_now["x"]) + float(not_now["width"]))
    if gap < 0:
        problems.append("the primary button is not to the right of Not now")
    elif gap > MAX_BUTTON_GAP:
        problems.append(f"Not now and the primary are {gap:.0f}px apart (> {MAX_BUTTON_GAP:.0f}px)")
    if abs(float(add["y"]) - float(not_now["y"])) > 2.0:
        problems.append("Not now and the primary are not on one row")
    if not _filled(m.get("add_background")):
        problems.append("the add button is not styled as the primary (no fill)")
    if _filled(m.get("not_now_background")):
        problems.append("Not now is filled like a primary button")
    return problems


def offer_problems(m: dict, place: Optional[str] = None) -> list[str]:
    """Problems with the measured offer toast; ``[]`` when it matches Settings."""
    if not m:
        return []
    place = place or place_for()
    text = m.get("text") or ""
    problems = []
    if f"Add “{TITLE}” to {place}?" not in text:
        problems.append(f"the offer title does not name {place!r}: {text!r}")
    if m.get("add") != f"Add to {place}":
        problems.append(f"the primary reads {m.get('add')!r}, want {f'Add to {place}'!r}")
    if m.get("not_now") != "Not now":
        problems.append(f"the cancel reads {m.get('not_now')!r}, want 'Not now'")
    if OLD_SEPARATOR in text:
        problems.append(f"the offer uses {OLD_SEPARATOR!r} as path separator, not '▸'")
    if SETTINGS_PATH not in text:
        problems.append(f"the offer does not point at {SETTINGS_PATH!r}")
    return problems + _button_problems(m)


def later_note_problems(text: Optional[str]) -> list[str]:
    """Problems with the note "Not now" leaves (R-108): it must say where the offer lives."""
    if not text:
        return ["nothing says where to find the offer after Not now"]
    if SETTINGS_PATH not in text:
        return [f"the Not now note does not point at {SETTINGS_PATH!r}: {text!r}"]
    return []
