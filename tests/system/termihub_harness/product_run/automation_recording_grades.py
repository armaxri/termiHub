"""Grade recording into an automation (#5818, slice 8), without an app.

The functions here grade what a live run reads over the bridge and from
``automations.json``; each returns a list of problems, empty when the surface
passes.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

#: The toolbar's record row, its chip while recording, and their words.
RECORD = "terminal-view-record"
CHIP = "terminal-view-active-recording"
CHIP_HERE = "Stop recording"
CHIP_AT_PROMPT = "Stop recording (password kept apart)"
#: The dialog a stopped recording opens, and the bar that keeps it.
SAVE_DIALOG = "recording-save-dialog"
KEPT_BAR = "recording-bar-unsaved"
EDITOR_BAR = "recording-bar-editor"
#: The buttons of the save dialog that must be in view.
SAVE_BUTTONS = ("recording-save-keep", "recording-save-discard", "recording-save-confirm")
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0

Rect = Mapping[str, float]


def typed_text(automation: Optional[Mapping[str, Any]], step: int) -> Optional[str]:
    """What a Type keys step types, joined; None when it is no such step."""
    steps = (automation or {}).get("steps") or []
    if not -len(steps) <= step < len(steps) or steps[step].get("kind") != "type-keys":
        return None
    return "".join(chunk["data"] for chunk in steps[step].get("chunks") or [])


def recorded_problems(
    automation: Optional[Mapping[str, Any]], want: str, step: int = 0
) -> list[str]:
    """The stored step types exactly what was typed, at the recorded speed."""
    got = typed_text(automation, step)
    if got is None:
        return [f"step {step} does not type keys"]
    problems = [] if got == want else [f"it types {got!r}, not {want!r}"]
    stored = (automation or {})["steps"][step]
    if stored.get("timing") != "recorded":
        problems.append(f"its speed is {stored.get('timing')!r}, not 'recorded'")
    if stored.get("recorded") is not True:
        problems.append("it is not marked as recorded")
    return problems


def secret_problems(stored_file: str, secret: str) -> list[str]:
    """What was typed at a password prompt is nowhere in the stored file."""
    return [f"{secret!r} is stored in automations.json"] if secret in stored_file else []


def chip_problems(shown: Optional[str], want: Optional[str]) -> list[str]:
    """The toolbar chip says what the recording is doing; none when it is over."""
    if want is None:
        return [] if shown is None else [f"the chip still reads {shown!r}"]
    if shown is None:
        return ["no recording chip"]
    return [] if shown.strip() == want else [f"the chip reads {shown!r}, not {want!r}"]


def save_dialog_problems(summary: str, name: str, typed: str, want_name: str) -> list[str]:
    """The dialog shows what was typed, counts nothing (A-003), and offers it as the name."""
    problems = []
    if "Recorded in" not in summary or typed not in summary:
        problems.append(f"the dialog says {summary!r}, not that {typed!r} was recorded")
    if " key" in summary:
        problems.append(f"the dialog counts keys: {summary!r}")
    if name != want_name:
        problems.append(f"the offered name is {name!r}, not {want_name!r}")
    return problems


def wait_problems(bar: str, name: str, tab: str) -> list[str]:
    """The bar of a run that waits: which one, where, what to do, when it ends (#6025)."""
    wanted = (f"“{name}” waits for you in {tab}", "Type your password, then Continue", "Stops at")
    return [f"the bar does not say {text!r}: {bar!r}" for text in wanted if text not in bar]


def save_layout_problems(
    window: tuple[float, float], dialog: Rect, buttons: Sequence[Rect]
) -> list[str]:
    """The save dialog fits the window, with its buttons inside it."""
    problems = []
    for what, rect in [("the dialog", dialog), *[("a button", b) for b in buttons]]:
        if (
            rect["x"] < -EPS
            or rect["y"] < -EPS
            or rect["x"] + rect["width"] > window[0] + EPS
            or rect["y"] + rect["height"] > window[1] + EPS
        ):
            problems.append(f"{what} does not fit the window: {dict(rect)}")
    return problems
