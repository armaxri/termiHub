"""Grade the coalesced "Closed … / Reopen" toast (#5828), without an app.

The UI review of run ``20261123T215628Z`` (R-010) saw three identical
"Closed “Terminal” · Reopen" toasts stacked over the connection editor: nobody
could tell which Reopen restored which tab, and they covered the form. Closes
within a short window now share one toast (``src/utils/reopenTab.ts``): a
single close names the tab, several read "Closed N tabs", and its
"Reopen all" restores every tab in the order it was closed.

:func:`reopen_toast_problems` grades the toast stack's measured text items;
:func:`reopen_order_problems` grades the tabs Reopen brought back.
"""

from __future__ import annotations

from typing import Any, Sequence

#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


def expected_message(closed: Sequence[str]) -> str:
    """The toast title for the closed tab titles (twin of ``reopenToastMessage``)."""
    if len(closed) == 1:
        return f"Closed “{closed[0]}”"
    return f"Closed {len(closed)} tabs"


def expected_action(closed: Sequence[str]) -> str:
    """The toast's action label: "Reopen" for one tab, "Reopen all" for several."""
    return "Reopen" if len(closed) == 1 else "Reopen all"


def _intersects(a: dict[str, float], b: dict[str, float]) -> bool:
    return (
        a["x"] < b["x"] + b["width"] - EPS
        and b["x"] < a["x"] + a["width"] - EPS
        and a["y"] < b["y"] + b["height"] - EPS
        and b["y"] < a["y"] + a["height"] - EPS
    )


def closed_titles(items: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The toast text items that are a "Closed …" toast title."""
    return [i for i in items if (i.get("text") or "").startswith("Closed")]


def reopen_toast_problems(
    items: Sequence[dict[str, Any]],
    closed: Sequence[str],
    footer: Sequence[dict[str, Any]] = (),
) -> list[str]:
    """What is wrong with the reopen toast after closing the tabs ``closed``.

    ``items`` are the toast stack's visible text and button items (``text``,
    ``label``, ``rect``); ``footer`` the editor footer's visible buttons. Wants
    exactly one "Closed …" toast, titled for ``closed``, with its Reopen action,
    covering none of the footer buttons.
    """
    problems: list[str] = []
    titles = closed_titles(items)
    if not titles:
        return [f"no 'Closed …' toast after closing {len(closed)} tab(s)"]
    if len(titles) > 1:
        problems.append(
            f"{len(titles)} 'Closed …' toasts stack for {len(closed)} closes: "
            f"{[t['text'] for t in titles]} (want one toast)"
        )
    want = expected_message(closed)
    if titles[-1]["text"] != want:
        problems.append(f"toast reads {titles[-1]['text']!r}, want {want!r}")
    action = expected_action(closed)
    if not any((i.get("text") or i.get("label") or "") == action for i in items):
        problems.append(f"no {action!r} button on the toast")
    for item in items:
        for button in footer:
            if _intersects(item["rect"], button["rect"]):
                problems.append(
                    f"toast {item.get('text') or item.get('label')!r} covers the footer "
                    f"button {button.get('text')!r}"
                )
    return problems


def reopen_order_problems(closed: Sequence[str], reopened: Sequence[str]) -> list[str]:
    """What is wrong with the tabs Reopen brought back (titles in strip order)."""
    if list(reopened) == list(closed):
        return []
    if sorted(reopened) == sorted(closed):
        return [f"Reopen restored {list(reopened)} out of order, want {list(closed)}"]
    return [f"Reopen restored {list(reopened)}, want all of {list(closed)}"]
