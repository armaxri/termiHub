"""Editing keyboard shortcuts (#5842): drive it live, grade it without an app.

Settings ▸ Keyboard shortcuts rows show a visible "Change" label on the binding,
the plain "Default" marker while unchanged (a labelled "Reset to default"
button once changed), Cancel while recording, and a line under the row that
explains a conflict (Cancel · Reassign), a dead key or a plain function key
that terminal programs keep. Clearing offers Undo, and the two "Show keyboard
shortcuts" actions say where each one works.

:func:`measure_keyboard_editing` drives the open Keyboard category and records
what it saw; :func:`keyboard_shortcut_problems` grades that record and runs in
the normal (per-PR) lane.
"""

from __future__ import annotations

import re
import time
from typing import Any, Optional

from ..colors import parse_color

#: The row the grade records on (bound by default on every platform).
RECORD_ACTION = "toggle-sidebar"
#: The row that records the conflicting combo.
CONFLICT_ACTION = "new-terminal"
#: The combo that conflicts: Ctrl+Tab is "Next tab" on every platform.
CONFLICT_KEY = ("Tab", {"ctrl": True})
CONFLICT_OWNER_LABEL = "Next tab"
#: Rows whose Change label and Default marker are measured.
SAMPLE_ROWS = (RECORD_ACTION, CONFLICT_ACTION, "next-tab", "zoom-panel")
#: The pair the review read as near-duplicates (R-137).
HELP_PAIR = ("show-shortcuts", "show-shortcuts-outside-terminal")
#: Recording commits a single combo after this chord window (the app uses 800 ms).
CHORD_WINDOW_S = 1.2

_PX_RE = re.compile(r"(-?[\d.]+)px")


def _px(value: Optional[str]) -> float:
    match = _PX_RE.search(value or "")
    return float(match.group(1)) if match else 0.0


def _text(driver: Any, test_id: str) -> Optional[str]:
    return driver.get_text(test_id).strip() if driver.exists(test_id) else None


def _measure_row(driver: Any, action: str) -> dict:
    marker: Optional[dict] = None
    tag, reset = f"keybinding-default-{action}", f"keybinding-reset-{action}"
    if driver.exists(tag):
        marker = {
            "kind": "default",
            "text": _text(driver, tag),
            "border": driver.get_computed_style("border-top-width", tag),
            "background": driver.get_computed_style("background-color", tag),
        }
    elif driver.exists(reset):
        marker = {"kind": "reset", "text": _text(driver, reset)}
    return {
        "action": action,
        "exists": driver.exists(f"keybinding-row-{action}"),
        "change_text": _text(driver, f"keybinding-change-{action}"),
        "marker": marker,
    }


def _notice(driver: Any) -> dict:
    return {
        "text": _text(driver, "keyboard-settings-conflict"),
        "reassign": driver.exists("keybinding-conflict-reassign"),
        "cancel": driver.exists("keybinding-conflict-cancel"),
    }


def _record(driver: Any, action: str, key: str, mods: dict) -> None:
    driver.click(f"keybinding-change-{action}")
    time.sleep(0.2)
    driver.press_key(key, f"keybinding-binding-{action}", **mods)
    time.sleep(CHORD_WINDOW_S)


def _close_notice(driver: Any) -> None:
    for button in ("keybinding-conflict-cancel", "keybinding-notice-close"):
        if driver.exists(button):
            driver.click(button)


def _reset(driver: Any, action: str) -> None:
    if driver.exists(f"keybinding-reset-{action}"):
        driver.click(f"keybinding-reset-{action}")
        time.sleep(0.2)


def measure_keyboard_editing(driver: Any) -> dict:
    """Drive the open Keyboard shortcuts category; every change is reset again."""
    m: dict = {
        "rows": [_measure_row(driver, a) for a in SAMPLE_ROWS],
        "labels": {a: _text(driver, f"keybinding-label-{a}") for a in HELP_PAIR},
    }
    keys_id = f"keybinding-keys-{RECORD_ACTION}"
    before = _text(driver, keys_id)

    # Record: Change → a new chord → the row offers Reset to default.
    _record(driver, RECORD_ACTION, "j", {"ctrl": True, "alt": True})
    m["record"] = {
        "before": before,
        "after": _text(driver, keys_id),
        "reset_text": _text(driver, f"keybinding-reset-{RECORD_ACTION}"),
    }
    _reset(driver, RECORD_ACTION)

    # Cancel: Change → Escape leaves the binding as it was.
    driver.click(f"keybinding-change-{RECORD_ACTION}")
    time.sleep(0.2)
    cancel_visible = driver.exists(f"keybinding-cancel-{RECORD_ACTION}")
    driver.press_key("Escape", f"keybinding-binding-{RECORD_ACTION}")
    time.sleep(0.3)
    m["cancel"] = {"before": before, "after": _text(driver, keys_id),
                   "cancel_button": cancel_visible}

    # Conflict: the taken combo explains itself and offers Cancel · Reassign.
    key, mods = CONFLICT_KEY
    _record(driver, CONFLICT_ACTION, key, mods)
    m["conflict"] = _notice(driver)
    _close_notice(driver)

    # A plain function key on a global action is refused (#4773).
    _record(driver, RECORD_ACTION, "F5", {})
    m["function_key"] = {**_notice(driver), "after": _text(driver, keys_id)}
    _close_notice(driver)
    _reset(driver, RECORD_ACTION)

    # Clear offers Undo.
    driver.click(f"keybinding-unbind-{RECORD_ACTION}")
    time.sleep(0.4)
    m["undo"] = {
        "toast": driver.exists("keybinding-unbind-toast"),
        "undo_button": driver.exists("keybinding-unbind-toast-undo"),
    }
    if m["undo"]["undo_button"]:
        driver.click("keybinding-unbind-toast-undo")
        time.sleep(0.3)
    m["undo"]["restored"] = _text(driver, keys_id)
    _reset(driver, RECORD_ACTION)
    return m


def _row_problems(rows: "list[dict]") -> list[str]:
    problems = []
    for row in rows:
        action = row["action"]
        if not row.get("exists"):
            continue
        if row.get("change_text") != "Change":
            problems.append(f"{action}: no visible 'Change' on the binding "
                            f"(reads {row.get('change_text')!r})")
        marker = row.get("marker")
        if marker is None:
            problems.append(f"{action}: no Default marker or Reset to default")
        elif marker["kind"] == "default":
            if marker.get("text") != "Default":
                problems.append(f"{action}: the Default marker reads {marker.get('text')!r}")
            if _px(marker.get("border")) > 0:
                problems.append(f"{action}: the Default marker has a border (looks like a button)")
            if parse_color(marker.get("background") or "transparent").a > 0:
                problems.append(f"{action}: the Default marker has a fill (looks like a button)")
        else:
            problems.append(f"{action}: an unchanged row offers {marker.get('text')!r}")
    return problems


def _label_problems(labels: dict) -> list[str]:
    a, b = (labels.get(x) for x in HELP_PAIR)
    if not a or not b:
        return []
    problems = []
    if a == b:
        problems.append(f"the two help rows read the same: {a!r}")
    for label in (a, b):
        if "terminal" not in label.lower():
            problems.append(f"help row {label!r} does not say where it works")
    if a in b or b in a:
        problems.append(f"help rows {a!r} and {b!r} read as near-duplicates")
    return problems


def _flow_problems(m: dict) -> list[str]:
    problems = []
    rec = m.get("record")
    if rec:
        if not rec.get("after") or rec.get("after") == rec.get("before"):
            problems.append(f"recording did not change the binding ({rec.get('after')!r})")
        if rec.get("reset_text") != "Reset to default":
            problems.append(f"a changed row offers {rec.get('reset_text')!r}, "
                            "want 'Reset to default'")
    cancel = m.get("cancel")
    if cancel:
        if cancel.get("after") != cancel.get("before"):
            problems.append("Escape changed the binding instead of cancelling")
        if not cancel.get("cancel_button"):
            problems.append("no visible Cancel while recording")
    conflict = m.get("conflict")
    if conflict:
        text = conflict.get("text") or ""
        if CONFLICT_OWNER_LABEL not in text:
            problems.append(f"a conflict does not name the action that has it ({text!r})")
        if not (conflict.get("reassign") and conflict.get("cancel")):
            problems.append("a conflict offers no Cancel · Reassign")
    fkey = m.get("function_key")
    if fkey:
        text = fkey.get("text") or ""
        if "terminal" not in text.lower():
            problems.append(f"a plain function key was not refused for terminals ({text!r})")
        if fkey.get("after") and "F5" == fkey.get("after"):
            problems.append("a plain F5 was stored on a global action")
    undo = m.get("undo")
    if undo:
        if not (undo.get("toast") and undo.get("undo_button")):
            problems.append("clearing a shortcut offers no Undo")
        elif rec and undo.get("restored") != rec.get("before"):
            problems.append(f"Undo restored {undo.get('restored')!r}, want {rec.get('before')!r}")
    return problems


def keyboard_shortcut_problems(m: dict) -> list[str]:
    """What is wrong with editing shortcuts; empty when it is right (#5842)."""
    problems = _row_problems(m.get("rows", []))
    problems += _label_problems(m.get("labels", {}))
    problems += _flow_problems(m)
    return problems
