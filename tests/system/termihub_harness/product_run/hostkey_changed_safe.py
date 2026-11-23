"""The product run's changed-host-key "safe primary" grade (#5826).

Pure functions over the changed-key prompt's verdict buttons (their boxes and
``class`` attributes), so the grade runs without an app in the per-PR lane
(``tests/test_product_run_hostkey_changed_safe.py``) and on the live prompt in
the product run's SSH phase.

Before #5826 the footer read "Accept once" (red) · **Reject** · "Replace
trusted key" (red): the safe choice sat between two look-alike dangerous ones,
so a hurried click on either side accepted a possibly intercepted key.
:func:`changed_safe_problems` checks the fixed layout:

- "Reject" is the right-most verdict, with both accepts to its left;
- the accepts are grouped together, set apart from "Reject" by a wider gap
  than the one between them (nothing dangerous sits next to the safe choice
  on both sides);
- "Accept once" is the quiet link-style action, "Replace trusted key" is not.
"""

from __future__ import annotations

from typing import Any, Optional

#: The three verdict buttons, keyed as the grades name them.
VERDICTS = ("reject", "accept_once", "accept_for_host")

#: The class that renders "Accept once" as a link-style action.
LINK_CLASS = "ui-trust-prompt__link"

Rect = dict[str, Any]


def _name(verdict: str) -> str:
    return verdict.replace("_", " ")


def _has_class(class_attr: Optional[str], name: str) -> bool:
    return name in (class_attr or "").split()


def changed_safe_problems(
    rects: dict[str, Optional[Rect]], classes: dict[str, Optional[str]]
) -> list[str]:
    """What is unsafe about a changed-key prompt's verdict layout, or ``[]``.

    ``rects`` maps each of :data:`VERDICTS` to its button's viewport box
    (``{x, y, width, height}``, ``None`` when missing or hidden); ``classes``
    maps each to its ``class`` attribute.
    """
    missing = [v for v in VERDICTS if rects.get(v) is None]
    if missing:
        return [f"no visible {_name(v)} button" for v in missing]
    problems: list[str] = []
    reject = rects["reject"]
    accepts = sorted(("accept_once", "accept_for_host"), key=lambda v: rects[v]["x"])  # type: ignore[index]
    right_of_reject = [v for v in accepts if rects[v]["x"] >= reject["x"]]  # type: ignore[index]
    if right_of_reject:
        problems.append(
            "reject is not the right-most verdict: "
            + ", ".join(_name(v) for v in right_of_reject)
            + " sits right of it"
        )
    else:
        first, second = (rects[v] for v in accepts)
        inner_gap = second["x"] - (first["x"] + first["width"])  # type: ignore[index]
        outer_gap = reject["x"] - (second["x"] + second["width"])  # type: ignore[index]
        if outer_gap <= inner_gap:
            problems.append(
                f"reject is not set apart from the accepts (gap {outer_gap:.0f}px,"
                f" accepts {inner_gap:.0f}px apart)"
            )
    if not _has_class(classes.get("accept_once"), LINK_CLASS):
        problems.append("accept once is not the link-style action")
    if _has_class(classes.get("accept_for_host"), LINK_CLASS):
        problems.append("accept for host is link-styled, want a danger button")
    return problems
