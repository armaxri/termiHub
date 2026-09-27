"""VNC end-to-end UI tests through the bridge harness (TIN-006).

``core/tests/vnc.rs`` covers the ``vnc`` backend against real servers, but
nothing covered a VNC session through the app itself: opening the tab, mounting
the canvas, painting pixels, resizing, and surviving a server outage. These
suites drive the real app against the Docker ``vnc`` profile fixtures:

* ``vnc-server`` (x11vnc + Xvfb, classic VncAuth) — render, local rescale on a
  window resize, and disconnect/reconnect by stopping and starting the container.
* ``vnc-vencrypt-server`` (TigerVNC Xvnc, VeNCrypt X509) — the one fixture that
  accepts ``SetDesktopSize``, so a **dynamic-resolution** session in Match Window
  scaling really resizes the remote desktop to follow the tab (#3463 / #3556).

Both serve a static 1024x768 four-quadrant pattern (TL red, TR green, BL blue,
BR white). The ``sampleCanvas`` bridge verb reads the canvas's pixels, so the
tests assert the server's colours actually reached the screen — not just that a
canvas element exists.

The ``vnc_fixtures`` / ``vnc_vencrypt_fixtures`` session fixtures bring the
containers up (naming a service activates its compose profile) and skip cleanly
when no container runtime is available — the macOS/Windows nightly legs, which
have no Linux Docker daemon (TIN-007 / CI-020).
"""

from __future__ import annotations

import time
from typing import Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    VNC_CONTAINER_SUFFIX,
    VNC_FB_HEIGHT,
    VNC_FB_WIDTH,
    VNC_HOST,
    VNC_PASSWORD,
    VNC_PORT,
    VNC_QUADRANT_COLORS,
    VNC_VENCRYPT_CONTAINER_SUFFIX,
    VNC_VENCRYPT_PORT,
    ConnectionsUi,
    ContainerControl,
    ContainerRuntimeUnavailable,
    PasswordPromptUi,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
    wait_for_banner,
)

pytestmark = pytest.mark.integration

#: The fixtures' native framebuffer size.
FB_SIZE = (VNC_FB_WIDTH, VNC_FB_HEIGHT)
#: Budget for a fresh session to connect and paint its first full frame. A whole
#: 1024x768 frame travels as JSON to a software-rendered webview on CI.
PAINT_TIMEOUT = 60.0
#: Budget for a container to come back and greet with its RFB version string.
SERVER_READY_TIMEOUT = 90.0
#: Max difference between the remote desktop size and the tab's canvas size for a
#: dynamic session to count as "following the tab" (servers may round odd sizes).
SIZE_SLACK = 2


class _VncSuite(
    RemoteDesktopUi, PasswordPromptUi, SettingsUi, SidebarUi, TabsUi, ConnectionsUi, SystemTest
):
    """Shared flow: enable graphical types, then open one VNC tab at a time."""

    # A live graphical connect ships whole frames over IPC while the webview
    # paints them; give bridge commands the live-connect budget (#2460).
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def open_vnc_tab(
        self,
        purpose: str,
        port: int,
        *,
        scale_mode: Optional[str] = None,
        resolution_mode: Optional[str] = None,
        tls_verify: Optional[str] = None,
        auto_reconnect: bool = True,
    ) -> str:
        """Create + connect a VNC connection and wait for its session to go live.

        Closes every open tab first, so this tab's canvas is the only
        ``remote-desktop-canvas`` in the DOM. Returns the connection name.
        """
        self.enable_experimental_features()
        self.close_all_tabs()
        name = unique_name(purpose)
        self.create_vnc_connection(
            name,
            host=VNC_HOST,
            port=port,
            scale_mode=scale_mode,
            resolution_mode=resolution_mode,
            tls_verify=tls_verify,
            auto_reconnect=auto_reconnect,
        )
        self.handle_password_prompt(VNC_PASSWORD)
        self.wait(lambda: self.find_tab(name), what="the VNC tab to open")
        self.wait(
            lambda: self.remote_desktop_session_id() is not None,
            timeout=PAINT_TIMEOUT,
            what="the VNC session to open",
        )
        self.wait(lambda: self.driver.exists(self.CANVAS), what="the remote-desktop canvas")
        self.wait(
            lambda: self.remote_desktop_phase() == "active",
            timeout=PAINT_TIMEOUT,
            what="the VNC session to become active",
        )
        return name

    def wait_for_pattern(self, *, scale_mode: str = "fit", what: str = "") -> None:
        """Wait for the four-quadrant pattern at the native 1024x768 size."""
        self.wait(
            lambda: self.remote_resolution() == FB_SIZE,
            timeout=PAINT_TIMEOUT,
            what="the 1024x768 remote framebuffer",
        )
        self.wait_for_quadrants(
            VNC_QUADRANT_COLORS,
            FB_SIZE,
            scale_mode,
            timeout=PAINT_TIMEOUT,
            what=what or "the canvas to show the VNC test pattern",
        )


@pytest.mark.usefixtures("vnc_fixtures")
class TestVncRender(_VncSuite):
    """VNC-UI-01: a VNC tab mounts its canvas and paints the server's pixels."""

    def test_opens_a_remote_desktop_tab_with_a_canvas(self):
        name = self.open_vnc_tab("vnc-render", VNC_PORT)
        tab = self.active_tab()
        assert tab is not None and name in (tab.get("title") or "")
        assert tab.get("contentType") == "remote-desktop"
        assert self.driver.exists(self.TAB)
        width, height = self.canvas_size()
        assert width > 0 and height > 0, "the canvas never got a drawing surface"

    def test_canvas_shows_the_server_colours(self):
        # Same app, same tab as the previous method (methods run in order).
        self.wait_for_pattern()

    def test_status_bar_reports_the_remote_resolution(self):
        text = self.wait(
            lambda: (
                self.driver.exists("status-bar-remote-desktop")
                and self.driver.get_text("status-bar-remote-desktop")
            ),
            what="the remote-desktop status-bar segment",
        )
        assert f"{VNC_HOST}:{VNC_PORT}" in text
        assert f"{VNC_FB_WIDTH}×{VNC_FB_HEIGHT}" in text


@pytest.mark.usefixtures("vnc_fixtures")
class TestVncResize(_VncSuite):
    """VNC-UI-02: resizing the window rescales the canvas; the pattern stays true.

    x11vnc keeps its 1024x768 desktop (it refuses ``SetDesktopSize``), so under
    the default **Fit to Tab** scaling a resize is purely local: the canvas
    follows the tab and the framebuffer is re-letterboxed into it.
    """

    def test_window_resize_rescales_the_canvas(self):
        self.open_vnc_tab("vnc-resize", VNC_PORT, scale_mode="fit")
        self.wait_for_pattern(what="the pattern before the resize")
        before = self.canvas_size()

        target = (900, 650) if before[0] > 1000 else (1280, 800)
        self.driver.resize_window(*target)
        after = self.wait(
            lambda: (lambda size: size if size != before else None)(self.canvas_size()),
            what=f"the canvas to follow the window resize to {target}",
        )
        assert after != before

        # The remote kept its size; the canvas re-letterboxed it.
        assert self.remote_resolution() == FB_SIZE
        self.wait_for_quadrants(
            VNC_QUADRANT_COLORS,
            FB_SIZE,
            "fit",
            what=f"the pattern after resizing the canvas {before} -> {after}",
        )


@pytest.mark.usefixtures("vnc_vencrypt_fixtures")
class TestVncDynamicResolution(_VncSuite):
    """VNC-UI-03: a dynamic session's remote desktop follows the tab (#3556).

    Match Window scaling with Resolution "Dynamic" sends the tab's size to the
    server as ``SetDesktopSize``; TigerVNC honours it, so the remote framebuffer
    (surfaced to the status bar via ``remoteDesktopResolutions``) converges on the
    canvas size — first on connect, then again after a window resize.
    """

    def _follows_canvas(self) -> Optional[tuple[int, int]]:
        remote = self.remote_resolution()
        canvas = self.canvas_size()
        if remote is None:
            return None
        if all(abs(r - c) <= SIZE_SLACK for r, c in zip(remote, canvas)):
            return remote
        return None

    def test_remote_desktop_follows_the_window(self):
        control = ContainerControl(VNC_VENCRYPT_CONTAINER_SUFFIX)
        try:
            self.open_vnc_tab(
                "vnc-dynamic",
                VNC_VENCRYPT_PORT,
                scale_mode="match",
                resolution_mode="dynamic",
                tls_verify="insecure",
            )
            first = self.wait(
                self._follows_canvas,
                timeout=PAINT_TIMEOUT,
                what="the remote desktop to adopt the tab's size",
            )

            canvas = self.canvas_size()
            target = (900, 650) if canvas[0] > 1000 else (1280, 800)
            self.driver.resize_window(*target)
            self.wait(
                lambda: self.canvas_size() != canvas,
                what=f"the canvas to follow the window resize to {target}",
            )
            second = self.wait(
                lambda: (lambda size: size if size and size != first else None)(
                    self._follows_canvas()
                ),
                timeout=PAINT_TIMEOUT,
                what="the remote desktop to follow the resized tab",
            )
            assert second != first
            assert self.remote_desktop_phase() == "active"
        finally:
            # The dynamic session resized the shared Xvnc desktop; restart the
            # container so it serves its 1024x768 pattern again for anyone else
            # (core/tests/vnc.rs VNC-06/07 assert that size).
            self.close_all_tabs()
            try:
                control.restart()
                wait_for_banner(VNC_HOST, VNC_VENCRYPT_PORT, b"RFB ", timeout=SERVER_READY_TIMEOUT)
            except ContainerRuntimeUnavailable as exc:
                print(f"[vnc] could not restore {control.container}: {exc}")


@pytest.mark.usefixtures("vnc_fixtures")
class TestVncReconnect(_VncSuite):
    """VNC-UI-04: a server outage shows the disconnect overlay; the session
    reconnects once the server is back and paints the pattern again."""

    def _restart_server_after_outage(self, control: ContainerControl) -> None:
        control.start()
        wait_for_banner(VNC_HOST, VNC_PORT, b"RFB ", timeout=SERVER_READY_TIMEOUT)

    def test_manual_reconnect_after_server_outage(self):
        control = ContainerControl(VNC_CONTAINER_SUFFIX)
        # Auto-Reconnect off: the drop must rest on the manual Reconnect prompt.
        self.open_vnc_tab("vnc-manual-reconnect", VNC_PORT, auto_reconnect=False)
        self.wait_for_pattern(what="the pattern before the outage")
        try:
            control.stop()
            self.wait(
                lambda: self.remote_desktop_phase() == "error",
                timeout=PAINT_TIMEOUT,
                what="the disconnected overlay after the server went away",
            )
            assert self.driver.exists(self.RECONNECT)
            overlay = self.driver.get_text(self.OVERLAY_ERROR)
            assert "Connection lost" in overlay, overlay
            # No retry is running: the overlay stays put while the server is down.
            time.sleep(3)
            assert self.remote_desktop_phase() == "error"
        finally:
            self._restart_server_after_outage(control)

        self.driver.click(self.RECONNECT)
        self.wait(
            lambda: self.remote_desktop_phase() == "active",
            timeout=PAINT_TIMEOUT,
            what="the session to reconnect after clicking Reconnect",
        )
        self.wait_for_pattern(what="the pattern after the manual reconnect")

    def test_auto_reconnect_recovers_after_server_restart(self):
        control = ContainerControl(VNC_CONTAINER_SUFFIX)
        self.open_vnc_tab("vnc-auto-reconnect", VNC_PORT)
        self.wait_for_pattern(what="the pattern before the outage")
        try:
            control.stop()
            # Auto-Reconnect is on by default: the drop shows the retry overlay.
            self.wait(
                lambda: self.remote_desktop_phase() == "reconnecting",
                timeout=PAINT_TIMEOUT,
                what="the reconnecting overlay after the server went away",
            )
        finally:
            self._restart_server_after_outage(control)

        # The retry budget (3 attempts, 1s doubling) may run out before the
        # container is back; the session then rests on the manual prompt, which
        # is the documented end of the auto path — reconnect from there.
        phase = self.wait(
            lambda: (lambda p: p if p in ("active", "error") else None)(
                self.remote_desktop_phase()
            ),
            timeout=PAINT_TIMEOUT,
            what="the auto-reconnect to finish",
        )
        if phase == "error":
            self.driver.click(self.RECONNECT)
            self.wait(
                lambda: self.remote_desktop_phase() == "active",
                timeout=PAINT_TIMEOUT,
                what="the session to reconnect after the retry budget ran out",
            )
        self.wait_for_pattern(what="the pattern after the server restart")
