"""Remote desktop tab: honest waiting headline, Abort, toolbar state (#5836).

Two parts in one file:

* **Grade unit tests** (no app, the normal per-PR lane) for
  :func:`~termihub_harness.product_run.grades.remote_desktop_waiting_problems`
  and :func:`~termihub_harness.product_run.grades.remote_desktop_toolbar_problems`.
* **The product-run grade** (hand-triggered, ``scripts/internal/product-run.sh``;
  deselected without ``--product-run``) against the run's scripted VNC server on
  loopback. The tab is protocol-blind (VNC and RDP render through one
  component), so one protocol grades both.

What the usability review of run ``20261123T215628Z`` found (R-074, R-116,
R-117, R-129, R-136): the waiting overlay said "Connecting to …" while the
stepper showed Connect and Authenticate done, with no way to stop the wait; the
toolbar was never seen; nothing said whether keystrokes go to the remote
desktop; and the scale mode was not shown.
"""

from __future__ import annotations

import sys
import time
from typing import Any, Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    SSH_HOST,
    ConnectionsUi,
    PasswordPromptUi,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.vnc_server import QUADRANTS, ScriptedVncServer
from termihub_harness.product_run.grades import (
    REMOTE_DESKTOP_TOOLBAR_ACTIONS,
    REMOTE_DESKTOP_WAITING_ABORT,
    REMOTE_DESKTOP_WAITING_HEADING,
    remote_desktop_toolbar_problems,
    remote_desktop_waiting_problems,
)

# ── Grade unit tests (no app) ────────────────────────────────────────────────
WAITING_TEXT = (
    f"VNC 127.0.0.1 {REMOTE_DESKTOP_WAITING_HEADING} Connect Authenticate First frame "
    "Connected, waiting for the first frame… Abort"
)


def test_waiting_overlay_with_pending_headline_and_abort_passes():
    assert remote_desktop_waiting_problems(WAITING_TEXT, [REMOTE_DESKTOP_WAITING_ABORT]) == []


def test_waiting_overlay_saying_connecting_fails():
    text = WAITING_TEXT.replace(REMOTE_DESKTOP_WAITING_HEADING, "Connecting to 127.0.0.1…")
    problems = remote_desktop_waiting_problems(text, [REMOTE_DESKTOP_WAITING_ABORT])
    assert any("Connecting to" in p for p in problems), problems
    assert any("headline" in p for p in problems), problems


def test_waiting_overlay_without_abort_fails():
    problems = remote_desktop_waiting_problems(WAITING_TEXT, [])
    assert any("no Abort" in p for p in problems), problems


def _toolbar(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "buttons": list(REMOTE_DESKTOP_TOOLBAR_ACTIONS),
        "scaleMode": "fit",
        "scaleText": "Fit to tab",
        "keyboardState": "released",
        "keyboardText": "Keyboard to termiHub · click the desktop to type",
    }
    base.update(over)
    return base


def test_released_toolbar_passes():
    assert remote_desktop_toolbar_problems(_toolbar(), captured=False) == []


def test_captured_toolbar_passes():
    toolbar = _toolbar(
        keyboardState="captured", keyboardText="Keyboard to remote · Ctrl+Shift+Alt release"
    )
    assert remote_desktop_toolbar_problems(toolbar, captured=True) == []


def test_missing_action_fails():
    toolbar = _toolbar(buttons=[b for b in REMOTE_DESKTOP_TOOLBAR_ACTIONS if b != "remote-desktop-cad"])
    problems = remote_desktop_toolbar_problems(toolbar, captured=False)
    assert any("remote-desktop-cad" in p for p in problems), problems


def test_icon_only_scale_button_fails():
    problems = remote_desktop_toolbar_problems(_toolbar(scaleText=""), captured=False)
    assert any("scale button shows" in p for p in problems), problems


def test_scale_text_must_match_the_mode():
    problems = remote_desktop_toolbar_problems(_toolbar(scaleMode="pixel"), captured=False)
    assert any("'1:1 pixel'" in p for p in problems), problems


def test_unknown_scale_mode_fails():
    problems = remote_desktop_toolbar_problems(_toolbar(scaleMode="zoom"), captured=False)
    assert any("unknown scale mode" in p for p in problems), problems


def test_keyboard_state_must_follow_the_canvas():
    problems = remote_desktop_toolbar_problems(_toolbar(), captured=True)
    assert any("expected 'captured'" in p for p in problems), problems
    problems = remote_desktop_toolbar_problems(_toolbar(keyboardState=None), captured=False)
    assert any("keyboard state" in p for p in problems), problems


def test_captured_text_must_name_the_remote():
    toolbar = _toolbar(keyboardState="captured", keyboardText="Ctrl+Shift+Alt release")
    problems = remote_desktop_toolbar_problems(toolbar, captured=True)
    assert any("goes to the remote" in p for p in problems), problems


def test_released_text_must_name_termihub():
    problems = remote_desktop_toolbar_problems(_toolbar(keyboardText="click"), captured=False)
    assert any("goes to termiHub" in p for p in problems), problems


def test_hidden_toolbar_fails_when_it_should_show():
    problems = remote_desktop_toolbar_problems(_toolbar(opacity="0"), captured=False)
    assert any("not shown" in p for p in problems), problems
    assert remote_desktop_toolbar_problems(_toolbar(opacity="1"), captured=False) == []


# ── Product-run grade (hand-triggered) ───────────────────────────────────────
CONNECT_TIMEOUT = 60.0
VNC_PASSWORD = "product-run-rdp-pw"
RELEASE_HINT = "remote-desktop-release-hint"
SCALE = "remote-desktop-scale"
DISCONNECT = "remote-desktop-disconnect"


@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the product run's servers are POSIX-only")
class TestProductRunRemoteDesktopTab(
    ProductRunUi,
    RemoteDesktopUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Remote desktop tab"
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT
    vnc: Optional[ScriptedVncServer] = None

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        env = super().extra_app_env(request)
        cls.vnc = ScriptedVncServer()
        request.addfinalizer(cls.vnc.close)
        return env

    def _open_held(self, label: str) -> None:
        """A VNC tab to the scripted server, which holds its first frame."""
        self.enable_experimental_features()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.vnc.hold_frames()
        self.create_vnc_connection(
            unique_name(label), host=SSH_HOST, port=self.vnc.port, scale_mode="fit"
        )
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            if self.password_prompt_open():
                self.handle_password_prompt(VNC_PASSWORD)
                break
            time.sleep(0.5)
        self.wait(
            lambda: self.remote_desktop_phase() == "active",
            timeout=CONNECT_TIMEOUT, what="the VNC session to become active",
        )
        self.wait(lambda: self.driver.exists(self.OVERLAY_FIRST_FRAME),
                  what="the waiting-for-the-first-frame overlay")

    def _toolbar(self) -> dict[str, Any]:
        items = self.driver.measure_element(self.TOOLBAR, "buttons")["items"]
        return {
            "buttons": [i["testId"] for i in items if i.get("testId")],
            "scaleMode": self.driver.get_attribute(SCALE, "data-scale-mode"),
            "scaleText": self.driver.get_text(SCALE),
            "keyboardState": self.driver.get_attribute(RELEASE_HINT, "data-state"),
            "keyboardText": self.driver.get_text(RELEASE_HINT),
        }

    def _keyboard_state(self) -> Optional[str]:
        return self.driver.get_attribute(RELEASE_HINT, "data-state")

    def test_01_waiting_overlay(self):
        with self.step(
            "rd-tab.waiting",
            "A connected VNC session without a picture heads 'Waiting for the desktop…' and "
            "offers Abort (#5836)",
            expect="a VNC tab with the stepper (Connect ✓ Authenticate ✓ First frame), the "
            "headline 'Waiting for the desktop…' — not 'Connecting to …' — and an Abort button",
        ):
            try:
                self._open_held("pr-rd-wait")
                overlay = self.driver.measure_element(self.OVERLAY_FIRST_FRAME, "buttons")
                buttons = [i["testId"] for i in overlay["items"] if i.get("testId")]
                self.evidence(f"overlay text {overlay['text']!r}; buttons {buttons}")
                self.shot(label="waiting")
                problems = remote_desktop_waiting_problems(overlay["text"], buttons)
                assert not problems, problems
            finally:
                self.vnc.release_frames()

    def test_02_abort_stops_the_wait(self):
        with self.step(
            "rd-tab.abort",
            "Abort on the waiting overlay ends the session; the tab rests on 'Connection "
            "aborted' with Retry (#5836)",
            expect="the VNC tab on the 'Connection aborted' screen with Retry and Close tab",
        ):
            try:
                self._open_held("pr-rd-abort")
                self.driver.click(REMOTE_DESKTOP_WAITING_ABORT)
                self.wait(lambda: self.driver.exists(self.OVERLAY_ERROR),
                          what="the aborted resting screen")
                text = self.driver.get_text(self.OVERLAY_ERROR)
                self.evidence(f"after Abort: {text!r}")
                assert "aborted" in text.lower(), text
                assert self.driver.exists(self.RETRY), "no Retry after Abort"
            finally:
                self.vnc.release_frames()
        self.close_all_tabs()

    def test_03_toolbar_and_keyboard_state(self):
        with self.step(
            "rd-tab.toolbar",
            "Once the desktop paints, the toolbar shows on its own with its actions, the scale "
            "mode by name and where the keyboard goes (#5836)",
            expect="the four-quadrant desktop with the toolbar at the top: host, 'Keyboard to "
            "termiHub · click the desktop to type', Ctrl+Alt+Del, clipboard, 'Fit to tab', "
            "fullscreen, disconnect",
        ):
            self._open_held("pr-rd-toolbar")
            self.vnc.release_frames()
            self.wait_for_quadrants(
                QUADRANTS, (self.vnc.width, self.vnc.height), "fit", timeout=CONNECT_TIMEOUT
            )
            toolbar = self._toolbar()
            toolbar["opacity"] = self.driver.get_computed_style("opacity", self.TOOLBAR)
            self.evidence(f"toolbar: {toolbar}")
            self.shot(label="toolbar")
            problems = remote_desktop_toolbar_problems(toolbar, captured=False)
            assert not problems, problems
        with self.step(
            "rd-tab.captured",
            "Typing into the desktop captures the keyboard: focus ring, 'Keyboard captured' "
            "hint and the toolbar says keys go to the remote; the release chord hands it back",
            expect="the VNC desktop with an accent focus ring, the bottom hint 'Keyboard "
            "captured · Ctrl+Shift+Alt to release' and the toolbar's 'Keyboard to remote'",
        ):
            self.require("rd-tab.toolbar")
            self.driver.press_key("Shift", self.CANVAS)
            self.wait(lambda: self._keyboard_state() == "captured", timeout=10.0,
                      what="the toolbar to say the keyboard is captured")
            self.driver.force_hover(self.TAB)
            try:
                self.shot(label="captured")
                problems = remote_desktop_toolbar_problems(self._toolbar(), captured=True)
                assert not problems, problems
                assert self.driver.exists("remote-desktop-capture-hint"), "no on-canvas capture hint"
            finally:
                self.driver.force_hover(None)
            self.driver.press_key("Shift", self.CANVAS, ctrl=True, alt=True, shift=True)
            self.wait(lambda: self._keyboard_state() == "released", timeout=10.0,
                      what="the release chord to hand the keyboard back")
        with self.step(
            "rd-tab.disconnect",
            "The toolbar's Disconnect ends the session and does not dial again (#5836)",
            expect="the VNC tab on the 'Session ended' screen with Reconnect and Close tab",
        ):
            self.require("rd-tab.toolbar")
            before = self.vnc.connections()
            self.driver.force_hover(self.TAB)
            try:
                self.driver.click(DISCONNECT)
            finally:
                self.driver.force_hover(None)
            self.wait(lambda: self.driver.exists(self.RECONNECT),
                      what="the Session ended resting screen")
            time.sleep(2.0)  # a reconnect would have dialled by now
            text = self.driver.get_text(self.OVERLAY_ERROR)
            self.evidence(f"after Disconnect: {text!r}; connections {before} -> {self.vnc.connections()}")
            assert "Session ended" in text, text
            assert self.vnc.connections() == before, "Disconnect dialled the server again"
        self.close_all_tabs()
