"""OS file drops onto the test instance, synthetic or real (#4936).

Tauri catches an OS file drag at the native layer and reports it to the page
as four window events — ``tauri://drag-enter`` (paths + position),
``tauri://drag-over`` (position), ``tauri://drag-drop`` (paths + position) and
``tauri://drag-leave`` — which ``useOsFileDrop`` hit-tests against its drop
zones. Positions are **physical** pixels relative to the webview, so a CSS
point is multiplied by ``devicePixelRatio``.

:class:`OsDropUi` emits exactly those events through the bridge's
``emitEvent`` verb (a global emit reaches every window's
``onDragDropEvent`` listener), so the app half of a drop — hover highlight,
pane hit-testing, quoting, copy/upload — runs unchanged on every OS. The
native half (X11 XDND between real windows) is driven separately by
:mod:`termihub_harness.os_input.xdnd`.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Union

from ..bridge import Driver
from .base import HarnessMixin

DRAG_ENTER = "tauri://drag-enter"
DRAG_OVER = "tauri://drag-over"
DRAG_DROP = "tauri://drag-drop"
DRAG_LEAVE = "tauri://drag-leave"

PathLike = Union[str, Path]

#: Set by a scaled-display lane (#4997, e.g. ``2`` under ``GDK_SCALE=2``): the
#: ``devicePixelRatio`` the test instance must report, so a drop grade meant to
#: run at a scale other than 1 fails instead of silently grading at 1x.
EXPECT_DPR_ENV = "TERMIHUB_EXPECT_DEVICE_PIXEL_RATIO"


def expected_device_pixel_ratio(env: Optional[Mapping[str, str]] = None) -> Optional[float]:
    """The ``devicePixelRatio`` this lane demands, or None when it demands none."""
    raw = (os.environ if env is None else env).get(EXPECT_DPR_ENV, "").strip()
    return float(raw) if raw else None


def check_device_pixel_ratio(probe: Mapping[str, Any], env: Optional[Mapping[str, str]] = None) -> float:
    """The probed ``devicePixelRatio``; raises when it is not the lane's expected one."""
    dpr = float(probe.get("devicePixelRatio") or 1.0)
    expected = expected_device_pixel_ratio(env)
    if expected is not None and abs(dpr - expected) > 0.01:
        raise AssertionError(
            f"the test instance reports devicePixelRatio {dpr}, but {EXPECT_DPR_ENV}="
            f"{expected}: the scaled-display lane is grading at the wrong scale"
        )
    return dpr


def physical_point(probe: dict[str, Any], fx: float = 0.5, fy: float = 0.5) -> dict[str, float]:
    """The physical-pixel webview point at fraction ``(fx, fy)`` of ``probe['rect']``.

    ``probe`` is an ``osInputProbe`` result for one element: its client rect in
    CSS pixels and the window's ``devicePixelRatio``.
    """
    rect = probe.get("rect")
    if not rect or rect["width"] <= 0 or rect["height"] <= 0:
        raise AssertionError(f"drop target has no laid-out box: {rect}")
    dpr = float(probe.get("devicePixelRatio") or 1.0)
    x = rect["left"] + rect["width"] * fx
    y = rect["top"] + rect["height"] * fy
    return {"x": round(x * dpr, 2), "y": round(y * dpr, 2)}


def drop_payloads(
    paths: Iterable[PathLike], position: dict[str, float]
) -> list[tuple[str, Optional[dict[str, Any]]]]:
    """The enter → over → drop event sequence Tauri emits for one drop at ``position``."""
    names = [str(p) for p in paths]
    return [
        (DRAG_ENTER, {"paths": names, "position": position}),
        (DRAG_OVER, {"position": position}),
        (DRAG_DROP, {"paths": names, "position": position}),
    ]


class OsDropUi(HarnessMixin):
    """Mixin: synthetic Tauri drag-drop events aimed at an element's box."""

    def os_drop_point(
        self, test_id: str, fx: float = 0.5, fy: float = 0.5, driver: Optional[Driver] = None
    ) -> dict[str, float]:
        """Physical webview point inside the element tagged ``test_id``."""
        return physical_point((driver or self.driver).os_input_probe(test_id), fx, fy)

    def os_drag_enter(
        self,
        test_id: str,
        paths: Iterable[PathLike],
        *,
        fx: float = 0.5,
        fy: float = 0.5,
        driver: Optional[Driver] = None,
    ) -> None:
        """An OS drag carrying ``paths`` enters the window over ``test_id``."""
        drv = driver or self.driver
        position = self.os_drop_point(test_id, fx, fy, drv)
        drv.emit_event(DRAG_ENTER, {"paths": [str(p) for p in paths], "position": position})
        drv.emit_event(DRAG_OVER, {"position": position})

    def os_drag_over(
        self, test_id: str, *, fx: float = 0.5, fy: float = 0.5, driver: Optional[Driver] = None
    ) -> None:
        """The OS drag moves over ``test_id``."""
        drv = driver or self.driver
        drv.emit_event(DRAG_OVER, {"position": self.os_drop_point(test_id, fx, fy, drv)})

    def os_drag_leave(self, driver: Optional[Driver] = None) -> None:
        """The OS drag leaves the window (or is cancelled)."""
        (driver or self.driver).emit_event(DRAG_LEAVE)

    def os_drop(
        self,
        test_id: str,
        paths: Iterable[PathLike],
        *,
        fx: float = 0.5,
        fy: float = 0.5,
        driver: Optional[Driver] = None,
    ) -> None:
        """Enter, hover and release an OS drag of ``paths`` over ``test_id``."""
        drv = driver or self.driver
        position = self.os_drop_point(test_id, fx, fy, drv)
        for event, payload in drop_payloads(paths, position):
            drv.emit_event(event, payload)
