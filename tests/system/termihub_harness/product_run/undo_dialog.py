"""Grade an undo offer across a dialog (#5914), without an app.

Under #5830 opening any dialog dismissed every success toast still showing,
undo offers ("Closed … · Reopen", "Deleted … · Undo") included, so an
unrelated dialog took the recovery away. An undo offer is now hidden while the
dialog is open and shown again, with the lifetime it had left, once the dialog
closes (``src/components/ui/Toast/toast.ts``).

:func:`undo_across_dialog_problems` grades the toast stack's measured text and
button items at three moments: before the dialog opens, while it is open and
after it closed.
"""

from __future__ import annotations

from typing import Any, Sequence


def _texts(items: Sequence[dict[str, Any]]) -> list[str]:
    return [(i.get("text") or i.get("label") or "") for i in items]


def offer_shown(items: Sequence[dict[str, Any]], title: str, action: str) -> bool:
    """Whether the toast items show the offer ``title`` with its ``action`` button."""
    texts = _texts(items)
    return title in texts and action in texts


def undo_across_dialog_problems(
    before: Sequence[dict[str, Any]],
    during: Sequence[dict[str, Any]],
    after: Sequence[dict[str, Any]],
    title: str,
    action: str,
) -> list[str]:
    """What is wrong with the undo offer ``title`` · ``action`` across a dialog.

    Wants the offer on screen before the dialog opens, off screen while it is
    open (it would sit over the backdrop that blocks its button), and back on
    screen, button included, once the dialog closed: exactly once each time.
    """
    problems: list[str] = []
    if not offer_shown(before, title, action):
        problems.append(f"no {title!r} · {action!r} toast before the dialog opened")
    if title in _texts(during):
        problems.append(f"the {title!r} toast shows beside the open dialog (want it hidden)")
    if not offer_shown(after, title, action):
        problems.append(
            f"the {title!r} · {action!r} toast did not come back after the dialog closed "
            f"(saw {_texts(after)})"
        )
    elif _texts(after).count(title) > 1:
        problems.append(f"{_texts(after).count(title)} {title!r} toasts after the dialog closed")
    return problems
