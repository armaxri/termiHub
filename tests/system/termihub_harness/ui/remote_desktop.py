"""Graphical remote-desktop (VNC/RDP) tab helpers (TIN-006).

``RemoteDesktopUi`` creates a VNC connection through the real connection editor,
reads the shared remote-desktop tab's lifecycle from the overlays it renders,
reads the live remote resolution the tab surfaces to the store, and — through the
``sampleCanvas`` bridge verb — samples the pixels the canvas actually painted.

The remote-desktop tab is protocol-blind (one canvas/overlay/toolbar set for
every graphical backend), so everything except :meth:`create_vnc_connection` is
reusable by a future RDP suite.

Graphical connection types ship **experimental** (hidden unless the user enables
experimental features), so a suite enables them first via
:class:`~termihub_harness.ui.SettingsUi`, and answers the Save & Connect password
prompt via :class:`~termihub_harness.ui.PasswordPromptUi`; both are borrowed.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Iterable, Optional

from .base import HarnessMixin

#: Tolerance (per 8-bit channel) when comparing a sampled canvas pixel with an
#: expected colour. The fixtures' solid regions decode exactly, and the canvas
#: blits them with smoothing off, so this only absorbs colour-management noise.
COLOR_TOLERANCE = 16


def color_matches(
    rgba: Iterable[int], expected: tuple[int, int, int], *, tolerance: int = COLOR_TOLERANCE
) -> bool:
    """Whether a sampled ``[r, g, b, a]`` is opaque and within ``tolerance`` of RGB."""
    r, g, b, a = list(rgba)[:4]
    if a < 255 - tolerance:
        return False
    return all(abs(got - want) <= tolerance for got, want in zip((r, g, b), expected))


def framebuffer_to_canvas(
    fb_point: tuple[float, float],
    fb_size: tuple[int, int],
    canvas_size: tuple[int, int],
    scale_mode: str,
) -> tuple[int, int]:
    """Map a remote framebuffer pixel to the canvas pixel that shows it.

    Mirrors the draw geometry in ``RemoteDesktopCanvas.repaint``: **fit** scales
    uniformly and letterboxes (centred), **match** stretches each axis to fill,
    **pixel** draws 1:1 at the origin. The result is clamped into the canvas.
    """
    fx, fy = fb_point
    fb_w, fb_h = fb_size
    cw, ch = canvas_size
    if scale_mode == "pixel":
        x, y = fx, fy
    elif scale_mode == "match":
        x, y = fx * cw / fb_w, fy * ch / fb_h
    else:  # fit
        s = min(cw / fb_w, ch / fb_h)
        x = (cw - fb_w * s) / 2 + fx * s
        y = (ch - fb_h * s) / 2 + fy * s
    return (
        min(max(int(math.floor(x)), 0), cw - 1),
        min(max(int(math.floor(y)), 0), ch - 1),
    )


def quadrant_probe_points(fb_w: int, fb_h: int) -> dict[str, list[tuple[float, float]]]:
    """Three framebuffer points well inside each quadrant of a ``fb_w`` x ``fb_h``
    four-quadrant pattern: the quadrant centre plus two points a quarter of the way
    towards its outer corners (away from the quadrant edges and the centre, where
    the synthetic cursor marker is drawn)."""
    qw, qh = fb_w / 2, fb_h / 2
    origins = {
        "top-left": (0.0, 0.0),
        "top-right": (qw, 0.0),
        "bottom-left": (0.0, qh),
        "bottom-right": (qw, qh),
    }
    points: dict[str, list[tuple[float, float]]] = {}
    for name, (ox, oy) in origins.items():
        points[name] = [
            (ox + qw * 0.5, oy + qh * 0.5),
            (ox + qw * 0.25, oy + qh * 0.25),
            (ox + qw * 0.75, oy + qh * 0.75),
        ]
    return points


class RemoteDesktopUi(HarnessMixin):
    """Drive + introspect a graphical remote-desktop tab (canvas, overlays, size)."""

    if TYPE_CHECKING:  # borrowed from ConnectionsUi / PasswordPromptUi / TabsUi

        def open_new_connection_editor(self) -> None: ...

        def select_connection_type(self, type_id: str) -> None: ...

        def _select_when_available(self, test_id: str, value: str, *, what: str) -> None: ...

        def _click_editor_save(self, connect: bool) -> None: ...

        def require_connection(self, name: str) -> dict[str, Any]: ...

        def active_tab(self) -> Optional[dict[str, Any]]: ...

    CANVAS = "remote-desktop-canvas"
    TAB = "remote-desktop-tab"
    TOOLBAR = "remote-desktop-toolbar"
    OVERLAY_CONNECTING = "remote-desktop-overlay-connecting"
    OVERLAY_RECONNECTING = "remote-desktop-overlay-reconnecting"
    OVERLAY_ERROR = "remote-desktop-overlay-error"
    RECONNECT = "remote-desktop-reconnect"

    # -- connection editor ---------------------------------------------------
    def create_vnc_connection(
        self,
        name: str,
        *,
        host: str,
        port: int,
        scale_mode: Optional[str] = None,
        resolution_mode: Optional[str] = None,
        tls_verify: Optional[str] = None,
        auto_reconnect: bool = True,
        connect: bool = True,
    ) -> None:
        """Fill the editor for a VNC connection and save (or Save & Connect).

        The password is left empty on purpose: Save & Connect then raises the
        password prompt (answer it with ``handle_password_prompt``), exactly as a
        user without a stored credential sees it — and the entered secret rides
        the opened tab's config, so a manual Reconnect re-authenticates too.
        ``scale_mode`` (``fit``/``pixel``/``match``), ``resolution_mode``
        (``server``/``dynamic``/``fixed``) and ``tls_verify``
        (``system``/``insecure``/``ca``) pick the matching editor selects;
        ``auto_reconnect=False`` turns the default-on Auto-Reconnect off, so a drop
        rests on the manual Reconnect prompt instead of retrying.
        """
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", name)
        self.select_connection_type("vnc")
        self.wait(lambda: self.driver.exists("field-host"), what="the VNC connection fields")
        self.driver.type("field-host", str(host))
        self.driver.type("field-port", str(port))
        if scale_mode is not None:
            self._select_when_available(
                "field-scaleMode", scale_mode, what=f"the {scale_mode!r} scale mode"
            )
        if resolution_mode is not None:
            self._select_when_available(
                "field-resolutionMode",
                resolution_mode,
                what=f"the {resolution_mode!r} resolution mode",
            )
        if tls_verify is not None:
            self._select_when_available(
                "field-tlsVerify", tls_verify, what=f"the {tls_verify!r} TLS verification"
            )
        if not auto_reconnect:
            self.wait(
                lambda: self.driver.exists("field-autoReconnect"),
                what="the Auto-Reconnect toggle",
            )
            self.driver.click("field-autoReconnect")
        self._click_editor_save(connect)

    # -- lifecycle -----------------------------------------------------------
    def remote_desktop_phase(self) -> str:
        """The visible lifecycle phase of the (only) remote-desktop tab.

        Read from what the tab renders, since the session state lives in the
        tab's hook rather than the store: ``"reconnecting"`` / ``"connecting"`` /
        ``"error"`` from the overlay shown, ``"active"`` while the toolbar is
        mounted (state active or resizing), else ``"none"``.
        """
        if self.driver.exists(self.OVERLAY_RECONNECTING):
            return "reconnecting"
        if self.driver.exists(self.OVERLAY_CONNECTING):
            return "connecting"
        if self.driver.exists(self.OVERLAY_ERROR):
            return "error"
        if self.driver.exists(self.TOOLBAR):
            return "active"
        return "none"

    def remote_desktop_session_id(self) -> Optional[str]:
        """The backend graphical session id of the active tab, if connected."""
        tab = self.active_tab() or {}
        if tab.get("contentType") != "remote-desktop":
            return None
        session_id = tab.get("sessionId")
        return session_id if isinstance(session_id, str) and session_id else None

    def remote_resolution(self) -> Optional[tuple[int, int]]:
        """The live remote framebuffer size the active tab surfaced to the store.

        This is the ``remoteDesktopResolutions`` entry the status bar renders as
        ``W×H`` — updated from the frame stream whenever the remote resizes.
        """
        session_id = self.remote_desktop_session_id()
        if session_id is None:
            return None
        resolutions = self.driver.get_state("remoteDesktopResolutions") or {}
        entry = resolutions.get(session_id)
        if not isinstance(entry, dict):
            return None
        return int(entry["width"]), int(entry["height"])

    # -- canvas --------------------------------------------------------------
    def canvas_size(self) -> tuple[int, int]:
        """The remote-desktop canvas's backing-store size."""
        sample = self.driver.sample_canvas(self.CANVAS)
        return int(sample["width"]), int(sample["height"])

    def sample_quadrants(
        self, fb_size: tuple[int, int], scale_mode: str
    ) -> dict[str, list[list[int]]]:
        """Sample the canvas at the probe points of each four-quadrant region.

        ``fb_size`` is the remote framebuffer size being displayed and
        ``scale_mode`` how the canvas draws it; together with the canvas size they
        place each framebuffer probe point on the canvas pixel that shows it.
        """
        canvas = self.canvas_size()
        probes = quadrant_probe_points(*fb_size)
        names: list[str] = []
        points: list[tuple[int, int]] = []
        for name, fb_points in probes.items():
            for fb_point in fb_points:
                names.append(name)
                points.append(framebuffer_to_canvas(fb_point, fb_size, canvas, scale_mode))
        pixels = self.driver.sample_canvas(self.CANVAS, points)["pixels"]
        result: dict[str, list[list[int]]] = {name: [] for name in probes}
        for name, rgba in zip(names, pixels):
            result[name].append(list(rgba))
        return result

    def quadrants_match(
        self,
        expected: dict[str, tuple[int, int, int]],
        fb_size: tuple[int, int],
        scale_mode: str,
    ) -> bool:
        """Whether every probe of every quadrant shows its expected colour."""
        sampled = self.sample_quadrants(fb_size, scale_mode)
        return all(
            all(color_matches(rgba, expected[name]) for rgba in pixels)
            for name, pixels in sampled.items()
        )

    def wait_for_quadrants(
        self,
        expected: dict[str, tuple[int, int, int]],
        fb_size: tuple[int, int],
        scale_mode: str,
        *,
        timeout: float = 30.0,
        what: str = "the remote framebuffer to paint the test pattern",
    ) -> None:
        """Poll until the canvas shows ``expected`` in every quadrant.

        On timeout the assertion names what the canvas actually showed, so a
        nightly failure says *which* quadrant was wrong (black = nothing painted,
        a swapped colour = a channel-order bug, …).
        """
        try:
            self.wait(
                lambda: self.quadrants_match(expected, fb_size, scale_mode),
                timeout=timeout,
                what=what,
            )
        except AssertionError as exc:
            try:
                seen = self.sample_quadrants(fb_size, scale_mode)
            except Exception as sample_exc:  # noqa: BLE001 — diagnostics only
                seen = {"<sample failed>": [[repr(sample_exc)]]}
            raise AssertionError(f"{exc}; canvas showed {seen}") from exc
