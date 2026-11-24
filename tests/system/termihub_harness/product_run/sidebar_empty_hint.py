"""Grade where the workflows experimental note shows (#5873, #5954).

#5873 turned the empty Connections sidebar's experimental signpost into one
short sentence and one button. The next UI review (#5954) found the note in the
wrong place: "Workflows are still experimental. Turn on in Settings." at the
end of the Connections empty state read as if connections needed an
experimental switch, and its action read as plain text. The note now lives
only in the Workflows view, while the switch is off, with a real secondary
button that opens Settings ▸ General.

:func:`connections_empty_problems` grades the Connections empty state's text;
:func:`measure_workflows_note` reads the Workflows note's boxes over the bridge
and :func:`workflows_note_layout_problems` grades them without an app.
"""

from __future__ import annotations

import re
from typing import Any, Optional

#: The Connections empty-state card.
CONNECTIONS_EMPTY = "connections-empty-state"

#: The Workflows note's container, sentence and button testIds.
NOTE = "workflow-experimental-notice"
NOTE_TEXT_ID = "workflow-experimental-text"
NOTE_ACTION = "workflow-experimental-action"

#: The sentence (``WORKFLOWS_EXPERIMENTAL_TEXT`` in ``WorkflowsExperimentalNotice.tsx``).
NOTE_TEXT = "Workflows are still experimental and turned off."
#: The button's label (``WORKFLOWS_EXPERIMENTAL_ACTION``).
ACTION_LABEL = "Turn on in Settings"
#: The class a secondary ``Button`` renders (``VARIANT_CLASS`` in ``Button.tsx``).
SECONDARY_CLASS = "ui-btn--secondary"
#: Words that must not show in the Connections empty state.
FORBIDDEN_IN_CONNECTIONS = ("experimental", "workflow", "turn on")
#: The sentence may wrap onto at most this many lines at the minimum width.
MAX_TEXT_LINES = 2
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


def _px(value: Optional[str], fallback: float) -> float:
    """A computed ``"16px"`` as a float, ``fallback`` for ``normal`` / unknown."""
    match = re.match(r"^\s*([\d.]+)px\s*$", value or "")
    return float(match.group(1)) if match else fallback


def _right(rect: dict[str, Any]) -> float:
    return float(rect["x"]) + float(rect["width"])


def _lines(height: float, line_height: float) -> int:
    return max(1, round(height / line_height))


def connections_empty_problems(text: Optional[str]) -> list[str]:
    """What is wrong with the Connections empty state's text (#5954).

    ``text`` is the card's visible text, ``None`` when there is no card. The
    card is about connections only: it names no experimental feature and offers
    no "turn on" action.
    """
    if text is None:
        return ["no empty-state card on the Connections sidebar"]
    lower = text.lower()
    return [
        f"the Connections empty state mentions {word!r}: {text!r}"
        for word in FORBIDDEN_IN_CONNECTIONS
        if word in lower
    ]


def measure_workflows_note(driver: Any) -> dict[str, Any]:
    """The boxes the grade reads: sidebar, the note, its sentence and its buttons."""
    sidebar = driver.measure_element("sidebar")["rect"]
    if not driver.exists(NOTE):
        return {"sidebar": sidebar, "note": None}
    text = driver.measure_element(NOTE_TEXT_ID) if driver.exists(NOTE_TEXT_ID) else None
    if text is not None:
        font = _px(driver.get_computed_style("font-size", NOTE_TEXT_ID), 11.0)
        text["lineHeight"] = _px(
            driver.get_computed_style("line-height", NOTE_TEXT_ID), font * 1.25
        )
    action_class = None
    if driver.exists(NOTE_ACTION):
        action_class = driver.get_attribute(NOTE_ACTION, "class")
    return {
        "sidebar": sidebar,
        "note": driver.measure_element(NOTE, "buttons"),
        "text": text,
        "actionClass": action_class,
    }


def workflows_note_layout_problems(m: dict[str, Any]) -> list[str]:
    """What is wrong with the Workflows note; empty when it is right (#5954).

    ``m`` is :func:`measure_workflows_note`'s result. The note holds one short
    sentence that wraps onto at most two lines and exactly one secondary button
    reading "Turn on in Settings", whose label is not clipped and stays inside
    the sidebar.
    """
    note = m.get("note")
    if note is None:
        return ["no experimental note in the Workflows view"]
    problems: list[str] = []
    text = m.get("text")
    if text is None:
        problems.append("the note has no sentence")
    else:
        sentence = " ".join((text.get("text") or "").split())
        if sentence != NOTE_TEXT:
            problems.append(f"the note reads {sentence!r}, not {NOTE_TEXT!r}")
        lines = _lines(float(text["rect"]["height"]), float(text["lineHeight"]))
        if lines > MAX_TEXT_LINES:
            problems.append(f"the sentence wraps onto {lines} lines")
    buttons = [b for b in note.get("items") or [] if b.get("visible", True)]
    if len(buttons) != 1:
        problems.append(f"the note has {len(buttons)} buttons, not one")
        return problems
    button = buttons[0]
    label = " ".join((button.get("text") or "").split())
    if label != ACTION_LABEL:
        problems.append(f"the button reads {label!r}, not {ACTION_LABEL!r}")
    if SECONDARY_CLASS not in (m.get("actionClass") or "").split():
        problems.append("the action is not styled as a secondary button")
    if button.get("overflows"):
        problems.append("the button's label is clipped")
    if _right(button["rect"]) > _right(m["sidebar"]) + EPS:
        problems.append("the button runs outside the sidebar")
    return problems
