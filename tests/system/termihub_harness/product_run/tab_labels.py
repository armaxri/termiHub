"""Measure and grade tab labels in a narrow strip (#5827).

The product-run UI review saw the "(2)" counter of a duplicate tab cut off and
two telnet tabs both reading "sys-pr-tel… Unencrypted". Tab titles are now
middle-truncated (``src/utils/tabTitleTruncation.ts``): only the head
ellipsizes, the tail (the end of the name plus any counter) always stays
whole. :func:`measure_tab_label` reads one tab's boxes over the bridge;
:func:`tab_label_problems` grades them without an app.
"""

from __future__ import annotations

import re
from typing import Any, Optional

#: Twin of ``TAB_TITLE_TAIL_CHARS`` in ``src/utils/tabTitleTruncation.ts``.
TAIL_CHARS = 8
#: A duplicate counter suffix such as `` (2)`` (``getTabDisplayTitle``).
COUNTER = re.compile(r"\s\((\d+)\)$")
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


#: Twin of ``AGENT_TAB_SEPARATOR`` / ``AGENT_SHELL_SUFFIX_MAX_CHARS`` (#5956).
AGENT_SEPARATOR = " · "
AGENT_SHELL_MAX_CHARS = 16


def expected_tail(title: str) -> str:
    """The tail the app keeps visible for ``title`` (twin of ``splitTabTitle``).

    An agent tab (``<agent> · <shell>``) keeps its shell suffix as the tail and
    the whole agent name in the head (#5956).
    """
    match = COUNTER.search(title)
    counter = match.group(0) if match else ""
    base = title[: len(title) - len(counter)] if counter else title
    at = base.rfind(AGENT_SEPARATOR)
    if at > 0:
        shell = base[at + len(AGENT_SEPARATOR):]
        if shell.strip() and len(shell) <= AGENT_SHELL_MAX_CHARS:
            return base[at:] + counter
    if len(base) <= TAIL_CHARS * 2:
        return counter
    return base[-TAIL_CHARS:] + counter


def measure_tab_label(driver: Any, tab_id: str, title: str) -> dict[str, Any]:
    """The boxes the grade reads for one tab: the tab, its title head and tail."""

    def measured(test_id: str) -> Optional[dict[str, Any]]:
        return driver.measure_element(test_id) if driver.exists(test_id) else None

    return {
        "id": tab_id,
        "title": title,
        "tab": driver.measure_element(f"tab-{tab_id}")["rect"],
        "head": measured(f"tab-title-head-{tab_id}"),
        "tail": measured(f"tab-title-tail-{tab_id}"),
    }


def head_clipped(tab: dict[str, Any]) -> bool:
    """Whether the tab's title head is ellipsized (narrower than its text)."""
    head = tab.get("head")
    return bool(head) and head["scrollWidth"] > head["clientWidth"] + EPS


def _tail_problems(tab: dict[str, Any]) -> list[str]:
    title, tail = tab["title"], tab.get("tail")
    want = expected_tail(title)
    if not want:
        return []
    if not tail:
        return [f"{title!r}: no always-visible tail (want {want!r})"]
    problems = []
    if tail["text"] != want.strip():
        problems.append(f"{title!r}: tail reads {tail['text']!r}, want {want.strip()!r}")
    if tail["scrollWidth"] > tail["clientWidth"] + EPS:
        problems.append(f"{title!r}: tail {tail['text']!r} is clipped")
    box, rect = tab["tab"], tail["rect"]
    if rect["width"] <= 0 or rect["x"] < box["x"] - EPS or (
        rect["x"] + rect["width"] > box["x"] + box["width"] + EPS
    ):
        problems.append(f"{title!r}: tail {rect} is outside its tab {box}")
    return problems


def tab_label_problems(tabs: list[dict[str, Any]]) -> list[str]:
    """Why these tabs' labels fail to tell them apart; empty when they pass.

    Every tab whose title has a tail keeps that tail whole and inside its tab, a
    duplicate's tail ends in its counter, and two tabs with different titles
    never show the same truncated label (the same tail with a clipped head).
    """
    problems = [p for tab in tabs for p in _tail_problems(tab)]
    for i, a in enumerate(tabs):
        for b in tabs[i + 1 :]:
            if a["title"] == b["title"] or not (head_clipped(a) and head_clipped(b)):
                continue
            tail_a = (a.get("tail") or {}).get("text", "")
            tail_b = (b.get("tail") or {}).get("text", "")
            if tail_a == tail_b:
                problems.append(
                    f"{a['title']!r} and {b['title']!r} both read '…{tail_a}' when truncated"
                )
    return problems
