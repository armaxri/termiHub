"""The product run's host-key button-emphasis grades (#5751).

Pure functions over the trust prompt's button ``class`` attributes, so the
grade runs without an app in the per-PR lane
(``tests/test_product_run_hostkey_emphasis.py``) and on the live prompts in the
product run's SSH phase.

- :func:`changed_emphasis_problems` — on a *changed* host key, both accepting
  verdicts ("Accept once", "Replace trusted key") are danger-styled and
  "Reject" is the primary action.
- :func:`first_contact_emphasis_problems` — first contact keeps its weights:
  "Accept for host" primary, "Accept once" secondary, "Reject" ghost.
- :func:`enter_default_problems` — Enter on the changed-key prompt rejected it.
"""

from __future__ import annotations

import re
from typing import Optional

_VARIANT = re.compile(r"\bui-btn--(primary|secondary|ghost|danger)\b")

#: The three verdict buttons, keyed as the grades name them.
VERDICTS = ("reject", "accept_once", "accept_for_host")

#: The button style each verdict wants on a *changed* identity.
CHANGED_WANT = {"reject": "primary", "accept_once": "danger", "accept_for_host": "danger"}

#: The button style each verdict wants on first contact (unchanged by #5751).
FIRST_CONTACT_WANT = {"reject": "ghost", "accept_once": "secondary", "accept_for_host": "primary"}


def button_variant(class_attr: Optional[str]) -> Optional[str]:
    """The ``ui-btn--<variant>`` of a button's ``class`` attribute, or ``None``."""
    match = _VARIANT.search(class_attr or "")
    return match.group(1) if match else None


def _problems(classes: dict[str, Optional[str]], want: dict[str, str]) -> list[str]:
    problems: list[str] = []
    for verdict in VERDICTS:
        if classes.get(verdict) is None:
            problems.append(f"no {verdict.replace('_', ' ')} button")
            continue
        got = button_variant(classes[verdict])
        if got != want[verdict]:
            problems.append(f"{verdict.replace('_', ' ')} is {got or 'unstyled'}, want {want[verdict]}")
    return problems


def changed_emphasis_problems(classes: dict[str, Optional[str]]) -> list[str]:
    """What is wrong with a changed-key prompt's button emphasis, or ``[]``.

    ``classes`` maps each of :data:`VERDICTS` to its button's ``class``
    attribute (``None`` when the button is missing).
    """
    return _problems(classes, CHANGED_WANT)


def first_contact_emphasis_problems(classes: dict[str, Optional[str]]) -> list[str]:
    """What is wrong with a first-contact prompt's button emphasis, or ``[]``."""
    return _problems(classes, FIRST_CONTACT_WANT)


def enter_default_problems(*, closed: bool, connected: bool) -> list[str]:
    """Whether Enter on the open changed-key prompt rejected it, or ``[]``.

    ``closed``: the prompt closed after Enter. ``connected``: the session
    connected anyway (Enter accepted instead of rejecting).
    """
    if not closed:
        return ["Enter did not answer the changed-key prompt (Reject is not the default)"]
    if connected:
        return ["Enter accepted the changed key instead of rejecting it"]
    return []
