"""Live session-end grades the product run measures with a real key (#5966).

Follow-up to #5955: the status-bar SSH chip greys while its session is down,
and Enter in an ended terminal runs the session-end strip's action (Restart
for a local exit, Reconnect for a dropped link). The chip itself is graded by
:func:`~.session_end_consistency.ssh_chip_problems`; this module turns the
chip's raw markup into that grade's inputs and grades what one Enter did.

* :func:`chip_reading` — the chip's ``data-down``, class list and accessible
  name from the attribute strings the bridge reads;
* :func:`enter_action_problems` — after Enter in an ended terminal the strip
  is gone, a session runs again, and a local Restart marks the scrollback
  "— restarted", never "— reconnected".

Both are pure and unit-tested without an app
(``tests/test_product_run_session_end_live.py``).
"""

from __future__ import annotations

from typing import Any, Optional

from .session_end_consistency import ENTER_HINTS, restart_marker_problems


def chip_reading(
    *, data_down: Optional[str], class_attr: Optional[str], aria_label: Optional[str]
) -> dict[str, Any]:
    """The keyword arguments of ``ssh_chip_problems`` (minus ``session_down``)."""
    return {
        "data_down": data_down,
        "classes": (class_attr or "").split(),
        "aria_label": (aria_label or "").strip(),
    }


def enter_action_problems(
    *,
    action: Optional[str],
    strip_up: bool,
    session_live: bool,
    scrollback: str,
) -> list[str]:
    """What is wrong with what Enter did in an ended terminal.

    ``action`` is the strip's ``data-action`` before Enter (``restart`` /
    ``reconnect``); ``strip_up`` and ``session_live`` are read after Enter
    settled, and ``scrollback`` is the terminal's text then. Wants the strip
    gone and a running session; for a Restart also the "— restarted" marker.
    """
    if action not in ENTER_HINTS:
        return [f"the strip's action before Enter was {action!r}, not restart / reconnect"]
    problems: list[str] = []
    if strip_up:
        problems.append(f"the session-end strip is still up after Enter ({action} did not run)")
    if not session_live:
        problems.append(f"no running session after Enter: Enter did not {action}")
    if action == "restart" and not strip_up and session_live:
        problems += restart_marker_problems(scrollback=scrollback)
    return problems
