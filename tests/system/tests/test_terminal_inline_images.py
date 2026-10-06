"""Terminal inline images: SIXEL and iTerm2 (PROD-057, PR #3442, #4013).

A local shell ``cat``s a tiny SIXEL and a tiny iTerm2 inline image. The image
lives in the image addon's store beside the text buffer, so the tests read it
through the ``inspect_terminal`` bridge verb and assert:

- each image is stored (``inlineImages.storageUsage`` grows) and no escape
  noise reaches the terminal text — the text around the images is intact;
- with the Inline Images setting off, the addon is unloaded, nothing is stored
  and still no escape noise reaches the text;
- after the shell exits and the tab reconnects, the text around the images is
  still in the scrollback while the image data is not (images are not kept
  across reconnects, by design).

The image bytes are written as files in the home directory on disk (#4025) and
``cat`` prints them, so no escape sequence is typed into the shell. The decode
and store wiring is also proven locally against the real addon in
``src/components/Terminal/inlineImages.real-addon.test.ts``; this suite adds the
real webview (canvas, ``createImageBitmap``) and the whole app path.

On Windows ``cat`` is PowerShell's ``Get-Content`` alias in the default local
shell, and the bytes pass through ConPTY. The inbox ConPTY strips the SIXEL DCS
string, so the app ships Microsoft's ``conpty.dll`` + ``OpenConsole.exe`` next
to ``termihub.exe`` (#4121), and this suite proves that host carries the images
through. It fails up front, rather than on a missing image, when the app under
test was built without them (build it with
``scripts/internal/build-system-test-app.sh``).
"""

from __future__ import annotations

import base64
from typing import Any

import pytest

from termihub_harness import orchestrator
from termihub_harness import (
    SETTINGS_REGION,
    ConnectionsUi,
    SettingsUi,
    ShellFsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: A 4x6 px red SIXEL image (DCS q … ST).
SIXEL = b"\x1bPq#0;2;100;0;0#0~~~~-\x1b\\"
#: A 1x1 px PNG.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE"
    "hQGAhKmMIQAAAABJRU5ErkJggg=="
)
#: The same PNG as an iTerm2 inline image (OSC 1337 ; File=… BEL).
IIP = (
    b"\x1b]1337;File=inline=1;size="
    + str(len(PNG)).encode()
    + b":"
    + base64.b64encode(PNG)
    + b"\x07"
)

SIXEL_FILE = "th_e2e_img_sixel.txt"
IIP_FILE = "th_e2e_img_iterm2.txt"

#: Pieces of the escape sequences that must never show up as terminal text.
ESCAPE_NOISE = (
    "#0;2;100",
    "~~~~",
    "1337",
    "File=",
    "inline=1",
    base64.b64encode(PNG)[:12].decode(),
)

INLINE_IMAGES_TOGGLE = "settings-terminal-inline-images"
RECONNECT = "terminal-disconnect-reconnect-btn"


@pytest.fixture(scope="module", autouse=True)
def _sideloaded_conpty_on_windows():
    """On Windows, insist the app under test carries the sideloaded ConPTY host.

    Without it local shells run on the inbox ConPTY, which drops SIXEL; the
    tests would then fail on a missing image with no hint why.
    """
    message = orchestrator.missing_sideloaded_conpty_message()
    if message:
        pytest.fail(message)


class TestTerminalInlineImages(
    TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SettingsUi, ShellFsUi, SystemTest
):
    @pytest.fixture(autouse=True)
    def _image_files(self):
        # Text before and after each image proves the surrounding output is
        # intact; it is not in the typed `cat` command, so only output matches.
        self.write_home_bytes(SIXEL_FILE, b"TH_SIXEL_BEFORE\n" + SIXEL + b"TH_SIXEL_AFTER\n")
        self.write_home_bytes(IIP_FILE, b"TH_IIP_BEFORE\n" + IIP + b"TH_IIP_AFTER\n")
        yield
        self.remove_home(SIXEL_FILE)
        self.remove_home(IIP_FILE)

    # -- helpers -------------------------------------------------------------
    def _open_shell(self) -> str:
        """Open a fresh local shell (in the home dir); return its tab id."""
        self.close_all_tabs()
        name = unique_name("inline-images")
        self.switch_to_connections_sidebar()
        self.create_local_connection(name, connect=True)
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")
        self.wait(lambda: self.driver.read_terminal(tab["id"]).strip(), what="the shell prompt")
        return tab["id"]

    def _cat(self, tab_id: str, name: str, until: str) -> str:
        """``cat`` a home file in the tab's shell; return the text once ``until`` shows."""
        self.wait(
            lambda: self.driver.terminal_input(f"cat ~/{name}", tab_id) is None,
            what=f"the shell to accept `cat {name}`",
        )
        return self.wait_for_output(until, tab_id=tab_id)

    def _images(self, tab_id: str) -> dict[str, Any]:
        images = self.driver.inspect_terminal(tab_id)["inlineImages"]
        assert images is not None, "the terminal must have an inline-images controller"
        return images

    def _assert_no_noise(self, text: str) -> None:
        for noise in ESCAPE_NOISE:
            assert noise not in text, f"escape noise {noise!r} reached the terminal text"

    def _inline_images_on(self) -> bool:
        # Absent from the settings region until first set; the default is on.
        return (
            self.projection_region_cache(SETTINGS_REGION).get("terminalInlineImages")
            is not False
        )

    def _set_inline_images(self, enabled: bool) -> None:
        """Flip the Inline Images toggle in Settings like a user does."""
        if self._inline_images_on() == enabled:
            return
        self.open_settings_category("terminal")
        self.wait(
            lambda: self.driver.exists(INLINE_IMAGES_TOGGLE), what="the Inline Images toggle"
        )
        self.driver.click(INLINE_IMAGES_TOGGLE)
        self.wait(
            lambda: self._inline_images_on() == enabled,
            what=f"Inline Images to be {'on' if enabled else 'off'}",
        )

    # -- tests -----------------------------------------------------------------
    def test_sixel_and_iterm2_images_are_stored_without_escape_noise(self):
        self._set_inline_images(True)
        tab_id = self._open_shell()
        self.wait(lambda: self._images(tab_id)["active"], what="the image addon to load")

        self._cat(tab_id, SIXEL_FILE, "TH_SIXEL_AFTER")
        after_sixel = self.wait(
            lambda: (lambda u: u if u > 0 else None)(self._images(tab_id)["storageUsage"]),
            what="the SIXEL image to be stored",
        )

        self._cat(tab_id, IIP_FILE, "TH_IIP_AFTER")
        self.wait(
            lambda: self._images(tab_id)["storageUsage"] > after_sixel,
            what="the iTerm2 image to be stored",
        )

        text = self.driver.read_terminal(tab_id)
        for marker in ("TH_SIXEL_BEFORE", "TH_SIXEL_AFTER", "TH_IIP_BEFORE", "TH_IIP_AFTER"):
            assert marker in text
        self._assert_no_noise(text)

    def test_setting_off_stores_nothing_and_prints_no_noise(self):
        self._set_inline_images(False)
        try:
            tab_id = self._open_shell()
            self._cat(tab_id, SIXEL_FILE, "TH_SIXEL_AFTER")
            text = self._cat(tab_id, IIP_FILE, "TH_IIP_AFTER")

            images = self._images(tab_id)
            assert images["active"] is False
            assert images["storageUsage"] == 0
            assert "TH_SIXEL_BEFORE" in text and "TH_IIP_BEFORE" in text
            self._assert_no_noise(text)
        finally:
            self._set_inline_images(True)

    def test_reconnect_keeps_the_text_around_images(self):
        self._set_inline_images(True)
        tab_id = self._open_shell()
        self.wait(lambda: self._images(tab_id)["active"], what="the image addon to load")
        self._cat(tab_id, SIXEL_FILE, "TH_SIXEL_AFTER")
        self.wait(lambda: self._images(tab_id)["storageUsage"] > 0, what="the image to be stored")

        self.wait(
            lambda: self.driver.terminal_input("exit", tab_id) is None,
            what="the shell to accept `exit`",
        )
        self.wait(lambda: self.driver.exists(RECONNECT), what="the Reconnect button")
        self.driver.click(RECONNECT)

        # Reconnecting replaces the xterm and its image addon. A loaded addon
        # with an empty store is that fresh instance (the old one held an image).
        self.wait(
            lambda: (lambda i: i["active"] and i["storageUsage"] == 0)(self._images(tab_id)),
            what="the reconnected terminal's fresh image addon",
        )
        # It replayed the old scrollback (#1126): the text survives, the image
        # data does not.
        text = self.wait_for_output("TH_SIXEL_AFTER", tab_id=tab_id)
        assert "TH_SIXEL_BEFORE" in text
        self._assert_no_noise(text)
