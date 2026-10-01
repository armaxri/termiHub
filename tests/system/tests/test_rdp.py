"""RDP end-to-end UI tests through the bridge harness (#4004, TIN-005/TIN-006).

``core/tests/rdp.rs`` drives the ``rdp`` backend and its IronRDP sidecar against
real servers, but nothing covered an RDP session through the app itself: the
connection editor, the remote-desktop tab's lifecycle, the canvas painting the
session, input reaching the server, resizing, certificate trust, clipboard and
recovering from an outage. These suites drive the real app against the Docker
``rdp`` profile fixture (``tests/docker/rdp-server``):

* xrdp on 3389 (TLS security, PAM logon): the session paints its whole root
  window pure red, runs a ``ping:`` -> ``pong:`` clipboard echo loop, and logs
  the key/button events it receives (``xev -root``) — so a test proves typed
  input reached the server, not just that the canvas handled a DOM event.
* A FreeRDP shadow server on 3390 (NLA/CredSSP) for the wrong-password path.

RDP decodes in the separately built ``termihub-rdp-helper`` sidecar. The
``rdp_fixtures`` session fixture points the app at a built helper and skips the
suite cleanly when none is built or no container runtime is available (the
macOS/Windows nightly legs have no Linux Docker daemon).
"""

from __future__ import annotations

import socket
import time
import uuid
from typing import Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    RDP_DESKTOP_COLOR,
    RDP_HOST,
    RDP_NLA_PORT,
    RDP_PASSWORD,
    RDP_PORT,
    RDP_USERNAME,
    ConnectionsUi,
    ContainerRuntimeUnavailable,
    PasswordPromptUi,
    RdpSessionProbe,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: Budget for a fresh session to log on and paint its first full frame. Whole
#: frames travel as JSON to a software-rendered webview on CI.
PAINT_TIMEOUT = 60.0
#: Budget for the restarted container's servers to answer again.
SERVER_READY_TIMEOUT = 90.0
#: Budget for one piece of input to show up at the server.
INPUT_TIMEOUT = 30.0
#: Max difference between the remote desktop size and the tab's canvas size for a
#: dynamic session to count as "following the tab" (servers may round sizes).
SIZE_SLACK = 4
#: The fixed resolution the fixed-size suite asks for.
FIXED_SIZE = (1024, 768)
#: The xev details of the left button and the ``a`` key in the input-probe log.
LEFT_BUTTON = "button 1,"
KEY_A = "keysym 0x61, a)"


def _unused_local_port() -> int:
    """A loopback TCP port nothing listens on (bound once, then released)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((RDP_HOST, 0))
        return sock.getsockname()[1]


class _RdpSuite(
    RemoteDesktopUi, PasswordPromptUi, SettingsUi, SidebarUi, TabsUi, ConnectionsUi, SystemTest
):
    """Shared flow: enable graphical types, then open one RDP tab at a time."""

    # A live graphical connect ships whole frames over IPC while the webview
    # paints them; give bridge commands the live-connect budget (#2460).
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def open_rdp_tab(
        self,
        purpose: str,
        *,
        port: int = RDP_PORT,
        password: str = RDP_PASSWORD,
        wait_active: bool = True,
        **editor: object,
    ) -> str:
        """Create an RDP connection in the editor, Save & Connect, answer the
        password prompt and (by default) wait for the session to go live.

        Closes every open tab first, so this tab's canvas is the only
        ``remote-desktop-canvas`` in the DOM. ``editor`` is passed through to
        :meth:`create_rdp_connection`. Returns the connection name.
        """
        self.enable_experimental_features()
        self.close_all_tabs()
        name = unique_name(purpose)
        self.create_rdp_connection(
            name, host=RDP_HOST, port=port, username=RDP_USERNAME, **editor
        )
        self.handle_password_prompt(password)
        self.wait(lambda: self.find_tab(name), what="the RDP tab to open")
        if wait_active:
            self.wait_until_active("the RDP session to become active")
        return name

    def wait_until_active(self, what: str) -> None:
        """Wait for the tab's session id, its canvas and the active toolbar."""
        self.wait(
            lambda: self.remote_desktop_session_id() is not None,
            timeout=PAINT_TIMEOUT,
            what=f"{what} (session id)",
        )
        self.wait(lambda: self.driver.exists(self.CANVAS), what=f"{what} (canvas)")
        self.wait(
            lambda: self.remote_desktop_phase() == "active",
            timeout=PAINT_TIMEOUT,
            what=what,
        )

    def wait_for_desktop(
        self,
        *,
        scale_mode: str = "fit",
        fb_size: Optional[tuple[int, int]] = None,
        what: str = "the canvas to show the red xrdp session desktop",
    ) -> tuple[int, int]:
        """Wait for the xrdp session's solid red desktop; returns its size."""
        return self.wait_for_solid_desktop(
            RDP_DESKTOP_COLOR, scale_mode, fb_size=fb_size, timeout=PAINT_TIMEOUT, what=what
        )

    def wait_for_error(self, heading: str, what: str) -> str:
        """Wait for the resting error overlay; assert its heading; return its text."""
        self.wait(
            lambda: self.remote_desktop_phase() == "error",
            timeout=PAINT_TIMEOUT,
            what=what,
        )
        text = self.driver.get_text(self.OVERLAY_ERROR)
        assert heading in text, text
        assert self.driver.exists(self.RECONNECT)
        return text

    @staticmethod
    def resize_target(canvas: tuple[int, int]) -> tuple[int, int]:
        """A window size that really changes the tab's canvas (see test_vnc.py)."""
        return (1000, 650) if canvas[0] > 800 else (1280, 800)


@pytest.mark.usefixtures("rdp_fixtures")
class TestRdpSession(_RdpSuite):
    """RDP-UI-01: an editor-created RDP connection logs on, paints the session's
    desktop, and forwards pointer, keyboard and clipboard input to the server.

    The methods share one app and one tab and run in order.
    """

    def test_editor_created_connection_opens_an_active_tab(self):
        name = self.open_rdp_tab("rdp-session")
        tab = self.active_tab()
        assert tab is not None and name in (tab.get("title") or "")
        assert tab.get("contentType") == "remote-desktop"
        assert tab.get("config", {}).get("type") == "rdp"
        assert self.driver.exists(self.TAB)
        # Active means the toolbar is up and no lifecycle overlay is showing.
        assert self.driver.exists(self.TOOLBAR)
        assert not self.driver.exists(self.OVERLAY_CONNECTING)
        assert not self.driver.exists(self.OVERLAY_ERROR)

    def test_canvas_paints_the_session_desktop(self):
        width, height = self.wait_for_desktop()
        assert width > 0 and height > 0

    def test_status_bar_reports_host_and_resolution(self):
        size = self.remote_resolution()
        assert size is not None
        text = self.wait(
            lambda: (
                self.driver.exists("status-bar-remote-desktop")
                and self.driver.get_text("status-bar-remote-desktop")
            ),
            what="the remote-desktop status-bar segment",
        )
        assert f"{RDP_HOST}:{RDP_PORT}" in text, text
        assert f"{size[0]}×{size[1]}" in text, text

    def test_click_moves_the_pointer_and_presses_the_button_on_the_server(self):
        probe = RdpSessionProbe()
        size = self.remote_resolution()
        assert size is not None
        # Park the session pointer in a corner first, so the click's move to
        # the desktop centre is an observable change (X starts it centred).
        probe.move_pointer(3, 3)
        assert probe.pointer() == (3, 3)
        before = probe.input_events("ButtonPress", LEFT_BUTTON)
        centre = (size[0] // 2, size[1] // 2)

        def clicked() -> bool:
            # The bridge clicks the canvas centre, which shows the desktop
            # centre under Fit scaling; re-click until the press is logged.
            self.driver.click(self.CANVAS)
            pointer = probe.pointer()
            near = pointer is not None and all(
                abs(p - c) <= 2 for p, c in zip(pointer, centre)
            )
            return near and probe.input_events("ButtonPress", LEFT_BUTTON) > before

        self.wait(
            clicked,
            timeout=INPUT_TIMEOUT,
            interval=1.0,
            what=f"a left click at the desktop centre {centre} to reach the xrdp session",
        )
        # The click landed on the remote: the canvas still shows the session.
        assert self.remote_desktop_phase() == "active"

    def test_typed_key_reaches_the_server(self):
        probe = RdpSessionProbe()
        before = probe.input_events("KeyPress", KEY_A)

        def typed() -> bool:
            self.driver.press_key("a", self.CANVAS)
            return probe.input_events("KeyPress", KEY_A) > before

        self.wait(
            typed,
            timeout=INPUT_TIMEOUT,
            interval=1.0,
            what="the `a` key typed into the canvas to reach the xrdp session",
        )

    def test_clipboard_text_round_trips_through_the_server(self):
        # The session echoes `ping:<x>` back as `pong:<x>` over CLIPRDR
        # (startwm.sh): seeing the pong in the panel proves text went to the
        # server and a new server copy came back into the tab.
        nonce = uuid.uuid4().hex[:12]
        ping, pong = f"ping:{nonce}", f"pong:{nonce}"
        self.driver.click(self.CLIPBOARD_BUTTON)
        self.wait(lambda: self.driver.exists(self.CLIPBOARD_TEXT), what="the clipboard panel")

        def echoed() -> bool:
            if self.driver.get_value(self.CLIPBOARD_TEXT) == pong:
                return True
            # CLIPRDR initialises asynchronously after logon: re-offer.
            self.driver.type(self.CLIPBOARD_TEXT, ping)
            self.driver.click(self.CLIPBOARD_SEND)
            time.sleep(1.0)
            return self.driver.get_value(self.CLIPBOARD_TEXT) == pong

        self.wait(
            echoed,
            timeout=PAINT_TIMEOUT,
            interval=0.5,
            what=f"the server's {pong!r} echo in the clipboard panel",
        )


@pytest.mark.usefixtures("rdp_fixtures")
class TestRdpCertificatePrompt(_RdpSuite):
    """RDP-UI-02: without "Ignore Certificate Errors" the fixture's self-signed
    certificate raises the trust prompt; accepting it once logs on."""

    def test_accepting_the_untrusted_certificate_connects(self):
        self.open_rdp_tab("rdp-cert", ignore_cert_errors=False, wait_active=False)
        self.wait(
            lambda: self.driver.exists(self.CERT_PROMPT),
            timeout=PAINT_TIMEOUT,
            what="the untrusted-certificate prompt",
        )
        assert self.driver.exists("cert-fingerprint")
        assert self.driver.get_text("cert-fingerprint").startswith("sha256:")
        self.driver.click(self.CERT_ACCEPT_ONCE)
        self.wait(
            lambda: not self.driver.exists(self.CERT_PROMPT),
            what="the certificate prompt to close",
        )
        self.wait_until_active("the session to log on after accepting the certificate")
        self.wait_for_desktop(what="the desktop after accepting the certificate")


@pytest.mark.usefixtures("rdp_fixtures")
class TestRdpResize(_RdpSuite):
    """RDP-UI-03: a dynamic session under Match Window scaling resizes the remote
    desktop to follow the tab (Display Control, MS-RDPEDISP), on connect and
    after a window resize; xrdp applies it and repaints the red desktop."""

    def _follows_canvas(self) -> Optional[tuple[int, int]]:
        remote = self.remote_resolution()
        canvas = self.canvas_size()
        if remote is None:
            return None
        if all(abs(r - c) <= SIZE_SLACK for r, c in zip(remote, canvas)):
            return remote
        return None

    def test_remote_desktop_follows_the_window(self):
        self.open_rdp_tab("rdp-dynamic", scale_mode="match", resolution_mode="dynamic")
        first = self.wait(
            self._follows_canvas,
            timeout=PAINT_TIMEOUT,
            what="the remote desktop to adopt the tab's size",
        )
        self.wait_for_desktop(scale_mode="match", fb_size=first)

        canvas = self.canvas_size()
        target = self.resize_target(canvas)
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
        self.wait_for_desktop(
            scale_mode="match", fb_size=second, what="the desktop repainted at the new size"
        )


@pytest.mark.usefixtures("rdp_fixtures")
class TestRdpFixedResolution(_RdpSuite):
    """RDP-UI-04: a fixed 1024x768 16-bit session keeps its size when the window
    resizes (the canvas rescales locally), and the status bar reports both."""

    def test_fixed_size_and_depth_survive_a_window_resize(self):
        self.open_rdp_tab(
            "rdp-fixed",
            resolution_mode="fixed",
            fixed_size=FIXED_SIZE,
            color_depth="16",
        )
        self.wait_for_desktop(fb_size=FIXED_SIZE, what="the fixed 1024x768 desktop")
        text = self.wait(
            lambda: (
                self.driver.exists("status-bar-remote-desktop")
                and self.driver.get_text("status-bar-remote-desktop")
            ),
            what="the remote-desktop status-bar segment",
        )
        assert f"{FIXED_SIZE[0]}×{FIXED_SIZE[1]}" in text, text
        assert "16-bit" in text, text

        canvas = self.canvas_size()
        target = self.resize_target(canvas)
        self.driver.resize_window(*target)
        self.wait(
            lambda: self.canvas_size() != canvas,
            what=f"the canvas to follow the window resize to {target}",
        )
        # No reflow on the remote: it stays 1024x768, re-letterboxed locally.
        time.sleep(2)
        assert self.remote_resolution() == FIXED_SIZE
        self.wait_for_desktop(fb_size=FIXED_SIZE, what="the desktop after the window resize")


@pytest.mark.usefixtures("rdp_fixtures")
class TestRdpReconnect(_RdpSuite):
    """RDP-UI-05: a server outage shows the disconnect overlay; the session
    reconnects once the server is back and paints the desktop again."""

    def _restore(self, probe: RdpSessionProbe) -> None:
        try:
            probe.restore(timeout=SERVER_READY_TIMEOUT)
        except ContainerRuntimeUnavailable as exc:
            pytest.fail(f"could not restore {probe.container}: {exc}")

    def test_manual_reconnect_after_server_outage(self):
        probe = RdpSessionProbe()
        # Auto-Reconnect off: the drop must rest on the manual Reconnect prompt.
        self.open_rdp_tab("rdp-manual-reconnect", auto_reconnect=False)
        self.wait_for_desktop(what="the desktop before the outage")
        try:
            probe.stop()
            text = self.wait_for_error(
                "Connection lost", "the disconnected overlay after the server went away"
            )
            assert text
            # No retry is running: the overlay stays put while the server is down.
            time.sleep(3)
            assert self.remote_desktop_phase() == "error"
        finally:
            self._restore(probe)

        self.driver.click(self.RECONNECT)
        self.wait_until_active("the session to reconnect after clicking Reconnect")
        self.wait_for_desktop(what="the desktop after the manual reconnect")

    def test_auto_reconnect_recovers_after_server_restart(self):
        probe = RdpSessionProbe()
        self.open_rdp_tab("rdp-auto-reconnect")
        self.wait_for_desktop(what="the desktop before the outage")
        try:
            probe.stop()
            # Auto-Reconnect is on by default: the drop shows the retry overlay.
            self.wait(
                lambda: self.remote_desktop_phase() == "reconnecting",
                timeout=PAINT_TIMEOUT,
                what="the reconnecting overlay after the server went away",
            )
        finally:
            self._restore(probe)

        # The retry budget may run out before the container is back; the session
        # then rests on the manual prompt, the documented end of the auto path.
        phase = self.wait(
            lambda: (lambda p: p if p in ("active", "error") else None)(
                self.remote_desktop_phase()
            ),
            timeout=PAINT_TIMEOUT,
            what="the auto-reconnect to finish",
        )
        if phase == "error":
            self.driver.click(self.RECONNECT)
            self.wait_until_active("the session to reconnect after the retry budget ran out")
        self.wait_for_desktop(what="the desktop after the server restart")


@pytest.mark.usefixtures("rdp_fixtures")
class TestRdpConnectErrors(_RdpSuite):
    """RDP-UI-06: failed connects rest on an error overlay with a Reconnect
    button — "Could not connect" for an unreachable host, "Authentication
    failed" for a wrong password rejected by an NLA server (#3612)."""

    def test_unreachable_host_shows_could_not_connect(self):
        self.open_rdp_tab(
            "rdp-unreachable",
            port=_unused_local_port(),
            auto_reconnect=False,
            wait_active=False,
        )
        self.wait_for_error("Could not connect", "the connect-failed overlay")
        assert self.remote_desktop_session_id() is None

    def test_wrong_password_on_nla_server_shows_authentication_failed(self):
        self.open_rdp_tab(
            "rdp-wrong-password",
            port=RDP_NLA_PORT,
            password="not-the-password",
            security_mode="nla",
            auto_reconnect=False,
            wait_active=False,
        )
        text = self.wait_for_error("Authentication failed", "the authentication-failed overlay")
        assert "Check the credentials" in text, text
