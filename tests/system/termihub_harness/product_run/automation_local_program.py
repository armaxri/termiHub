"""App-free grades of the question before a local program runs (#6019)."""

from __future__ import annotations

from typing import Any

#: What is not the user's own, and what they confirmed, in the config directory.
TRUST_FILE = "automation-trust.json"


def question_problems(
    lead: str, program: str, args: list[str], note: str, buttons: list[str], *, name: str,
    want_program: str, want_args: list[str],
) -> list[str]:
    """The question about a command of an imported automation: where it came from, the
    exact command, and that only this command can be remembered."""
    problems: list[str] = []
    if f"“{name}”" not in lead or "came from a file" not in lead:
        problems.append(f"it does not say where the automation came from: {lead!r}")
    if program != want_program:
        problems.append(f"it shows the program {program!r}, not {want_program!r}")
    if args != want_args:
        problems.append(f"it shows the arguments {args!r}, not {want_args!r}")
    if "exactly this command" not in note:
        problems.append(f"it does not say what is remembered: {note!r}")
    if buttons != ["Don't allow", "Allow once", "Allow this command"]:
        problems.append(f"the answers are {buttons!r}")
    return problems


def trust_problems(trust: Any, automation_id: str, *, confirmed: int) -> list[str]:
    """``automation-trust.json`` does not list the automation as the user's own, and has
    this many confirmed commands for it."""
    if not isinstance(trust, dict):
        return [f"{TRUST_FILE} is not a JSON object"]
    problems: list[str] = []
    if automation_id in (trust.get("own") or {}):
        problems.append("the imported automation is listed as the user's own")
    commands = (trust.get("confirmed") or {}).get(automation_id) or []
    if len(commands) != confirmed:
        problems.append(f"{len(commands)} commands are confirmed, not {confirmed}")
    return problems


def mark_problems(stored: Any) -> list[str]:
    """Nothing about it is stored in the automation itself, where a file could put it."""
    keys = {"own", "imported", "confirmed", "trusted"} & set(stored or {})
    return [f"the automation itself holds {sorted(keys)}"] if keys else []
