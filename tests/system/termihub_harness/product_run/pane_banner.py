"""Grade a terminal pane's disconnect banner (#5823), without an app.

The UI review of run ``20261123T215628Z`` (R-003) saw the "Agent disconnected —
press Enter or click Reconnect …" banner cut off at the bottom of the terminal
and its Reconnect button hidden under a "Saved …" toast: the one recovery
action on screen was covered. The banner (``TerminalViewModeBanner``) now sits
at the top of the pane like the reconnect strip, reads a short heading plus a
hint that wraps instead of clipping, and is a toast keep-clear zone.

:func:`pane_banner_problems` grades the measured banner, its pane, its
Reconnect button, its text items and the toast stack's items.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

#: Rounding slack for box comparisons, in CSS pixels (the slot may carry a 2px
#: tab-colour border).
EPS = 3.0

#: The heading the banner starts with, per cause.
HEADINGS = ("Agent disconnected.", "Session ended.")

Rect = Mapping[str, float]


def _intersects(a: Rect, b: Rect, eps: float = 0.5) -> bool:
    return (
        a["x"] < b["x"] + b["width"] - eps
        and b["x"] < a["x"] + a["width"] - eps
        and a["y"] < b["y"] + b["height"] - eps
        and b["y"] < a["y"] + a["height"] - eps
    )


def _inside(inner: Rect, outer: Rect, eps: float = EPS) -> bool:
    return (
        inner["x"] >= outer["x"] - eps
        and inner["y"] >= outer["y"] - eps
        and inner["x"] + inner["width"] <= outer["x"] + outer["width"] + eps
        and inner["y"] + inner["height"] <= outer["y"] + outer["height"] + eps
    )


def _shown(item: Mapping[str, Any]) -> bool:
    rect = item.get("rect") or {}
    return bool(item.get("visible", True)) and rect.get("width", 0) > 2 and rect.get("height", 0) > 2


def pane_banner_problems(
    *,
    banner: Rect,
    banner_text: str,
    pane: Rect,
    reconnect: Mapping[str, Any] | None,
    text_items: Sequence[Mapping[str, Any]] = (),
    toasts: Sequence[Mapping[str, Any]] = (),
    viewport: tuple[float, float] | None = None,
) -> list[str]:
    """What is wrong with a pane's disconnect banner.

    ``banner`` and ``pane`` are viewport boxes (``x``, ``y``, ``width``,
    ``height``); ``reconnect`` the banner's Reconnect button item (``rect``,
    ``visible``, ``overflows``) or ``None`` when missing; ``text_items`` the
    banner's own-text items; ``toasts`` the toast stack's visible items;
    ``viewport`` the window's inner size. Wants the banner at the top of the
    pane across its full width, short copy that is not clipped, and a fully
    visible Reconnect that no toast covers.
    """
    problems: list[str] = []
    text = " ".join(banner_text.split())
    if not text.startswith(HEADINGS):
        problems.append(f"banner text {text!r} does not start with one of {HEADINGS}")
    if abs(banner["y"] - pane["y"]) > EPS:
        problems.append(
            f"banner top {banner['y']:.0f} is not at the pane top {pane['y']:.0f} "
            "(it belongs at the top of the terminal, like the reconnect strip)"
        )
    if abs(banner["x"] - pane["x"]) > EPS or abs(banner["width"] - pane["width"]) > 2 * EPS:
        problems.append(
            f"banner {banner['x']:.0f}+{banner['width']:.0f} does not span the pane "
            f"{pane['x']:.0f}+{pane['width']:.0f}"
        )
    for item in text_items:
        if _shown(item) and item.get("overflows"):
            problems.append(f"banner text {item.get('text')!r} is clipped (ellipsized or cut off)")
    if reconnect is None or not _shown(reconnect):
        problems.append("the banner shows no visible Reconnect button")
        return problems
    rect = reconnect["rect"]
    if reconnect.get("overflows"):
        problems.append("the Reconnect label is clipped")
    if not _inside(rect, banner):
        problems.append(f"Reconnect {dict(rect)} sticks out of the banner {dict(banner)}")
    if viewport is not None:
        vw, vh = viewport
        if rect["x"] < -EPS or rect["y"] < -EPS or rect["x"] + rect["width"] > vw + EPS or (
            rect["y"] + rect["height"] > vh + EPS
        ):
            problems.append(f"Reconnect {dict(rect)} is outside the {vw:.0f}x{vh:.0f} window")
    for toast in toasts:
        if not _shown(toast):
            continue
        name = toast.get("text") or toast.get("label") or "toast"
        if _intersects(toast["rect"], rect):
            problems.append(f"toast {name!r} {dict(toast['rect'])} covers Reconnect")
        elif _intersects(toast["rect"], banner):
            problems.append(f"toast {name!r} {dict(toast['rect'])} covers the banner")
    return problems
