"""The product run's host-key layout grades (#5662).

Pure functions over :meth:`~termihub_harness.bridge.Driver.measure_element`
results, so the grade runs without an app in the per-PR lane
(``tests/test_product_run_hostkey_layout_grade.py``) and on the live trust
prompt / rejected-key screen in the product run's SSH phase.

- :func:`fingerprint_layout_problems` — a fingerprint row must not break
  mid-string (R-102) and keeps a visible gap before its copy button.
- :func:`rejected_screen_problems` — the rejected-key screen says "rejected"
  once (R-103): the heading, not a red error box and a paragraph repeating it.
"""

from __future__ import annotations

from typing import Any

#: The smallest visible gap between a fingerprint's text and its copy button
#: (the CSS gives ``--spacing-sm`` = 8 px; a little slack for sub-pixel layout).
MIN_COPY_GAP_PX = 6.0

#: A piece of the fingerprint taller than this many single lines has wrapped.
WRAPPED_LINE_RATIO = 1.5


def _right(rect: dict[str, float]) -> float:
    return float(rect["x"]) + float(rect["width"])


def fingerprint_layout_problems(
    text_items: list[dict[str, Any]],
    buttons: list[dict[str, Any]],
) -> list[str]:
    """What is wrong with one fingerprint row, or ``[]``.

    ``text_items`` is ``measure_element(<fingerprint dd>, "text")["items"]``: the
    fingerprint's chunks, plus the key-type line (which carries a
    ``data-testid`` and is skipped). ``buttons`` is the same with ``"buttons"``
    (the copy button).
    """
    problems: list[str] = []
    chunks = [i for i in text_items if i.get("text") and not i.get("testId") and i.get("visible")]
    if not chunks:
        return ["no visible fingerprint text"]
    # The shortest piece (e.g. "SHA256:") is one line tall; a longer piece that
    # is much taller wrapped inside itself — a mid-string break.
    line = min(float(c["rect"]["height"]) for c in chunks)
    for c in chunks:
        if line > 0 and float(c["rect"]["height"]) > line * WRAPPED_LINE_RATIO:
            problems.append(f"fingerprint piece {c['text']!r} breaks mid-string")
    copy = [b for b in buttons if b.get("visible")]
    if not copy:
        problems.append("no visible copy button beside the fingerprint")
    else:
        text_right = max(_right(c["rect"]) for c in chunks)
        gap = float(copy[0]["rect"]["x"]) - text_right
        if gap < MIN_COPY_GAP_PX:
            problems.append(
                f"the fingerprint runs into its copy button ({gap:.1f}px gap, want "
                f">= {MIN_COPY_GAP_PX:.0f}px)"
            )
    return problems


def rejected_screen_problems(text_items: list[dict[str, Any]]) -> list[str]:
    """What is wrong with the rejected-key screen, or ``[]``.

    ``text_items`` is ``measure_element("terminal-connection-overlay",
    "text")["items"]``. Screen-reader-only text (a 1 px live region) is skipped:
    only what is on screen counts.
    """
    on_screen = [
        i
        for i in text_items
        if i.get("visible") and float(i["rect"]["width"]) > 2 and float(i["rect"]["height"]) > 2
    ]
    saying = [i["text"] for i in on_screen if "rejected" in i.get("text", "").lower()]
    problems: list[str] = []
    if not saying:
        problems.append("the screen never says the key was rejected")
    elif len(saying) > 1:
        problems.append(f"the screen says it {len(saying)} times: {saying}")
    if not any("review the key again" in i.get("text", "").lower() for i in on_screen):
        problems.append("no one-line hint on what to do next")
    return problems
