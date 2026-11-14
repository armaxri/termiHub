"""Product run: the Touch ID unlock protection note (#5752).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Settings ▸ Security ▸ "Unlock with Touch ID" used to show an
"OS-enforced: no — …" paragraph under the toggle whether the unlock was on or
off. It now shows only while the unlock is on: an app-protected key (every
build without a Developer ID) reads "Less secure: other apps running as you
could read the unlock key." with the warning-hint icon; an OS-enforced key
reads a short "Protected by the operating system" note.

Steps:

* **off**: with a master-password store and the unlock off, no note shows.
* **on** (human, attended only): the operator turns the unlock on with Touch
  ID; the note shows the plain text (or the OS-enforced note on a signed build).

Without Touch ID hardware the Security panel has no biometric toggle, so both
steps skip, as the credentials phase's Touch ID step does.
"""

from __future__ import annotations

import sys
import time
from typing import Callable

import pytest

from termihub_harness import CredentialStoreUi, SettingsUi, SidebarUi, SystemTest
from termihub_harness.product_run import ProductRunUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform != "darwin", reason="Touch ID is macOS only"),
]

MASTER_PASSWORD = "product-run-touchid-pw"
NOTE = "biometric-unlock-protection"
TOGGLE = "biometric-unlock-toggle"
APP_PROTECTED_TEXT = "Less secure: other apps running as you could read the unlock key."
OS_ENFORCED_PREFIX = "Protected by the operating system"


class TestProductRunTouchIdNote(
    ProductRunUi, CredentialStoreUi, SettingsUi, SidebarUi, SystemTest
):
    phase = "Touch ID unlock note"
    request_timeout = 90.0

    def _within(self, check: Callable[[], bool], seconds: float) -> bool:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                if check():
                    return True
            except Exception:  # noqa: BLE001 - a transient bridge error is a "not yet"
                pass
            time.sleep(0.5)
        return False

    def _open_security_with_toggle(self) -> None:
        self.setup_master_password_store(MASTER_PASSWORD)
        self.open_settings_category("security")
        if not self._within(lambda: self.driver.exists(TOGGLE), 5.0):
            pytest.skip("Security shows no biometric unlock here (no Touch ID hardware?)")

    def _unlock_on(self) -> bool:
        return self.driver.get_attribute(TOGGLE, "aria-checked") == "true"

    def test_10_note_hidden_while_off(self):
        with self.step(
            "touchid-note.off",
            "Touch ID unlock off: no protection note under the toggle (#5752)",
            expect="Settings ▸ Security with Touch ID unlock off and no note beneath it",
        ):
            self._open_security_with_toggle()
            if self._unlock_on():
                pytest.skip("Touch ID unlock is already on in this profile")
            assert not self.driver.exists(NOTE), (
                f"a protection note shows while the unlock is off: {self.driver.get_text(NOTE)!r}"
            )
            self.evidence("unlock off, no protection note")

    def test_20_note_text_while_on(self):
        with self.step(
            "touchid-note.on",
            "Touch ID unlock on: the plain 'Less secure' note with a warning icon (#5752)",
            expect="Settings ▸ Security with Touch ID unlock on and the one-line note beneath it",
        ):
            self._open_security_with_toggle()
            if not self._unlock_on():
                self.human_step(
                    "In the test window: Settings ▸ Security ▸ turn on Unlock with Touch ID, "
                    f"type the master password '{MASTER_PASSWORD}' and confirm with Touch ID.",
                    "the toggle stays on and a one-line note shows beneath it",
                )
            self.wait(lambda: self.driver.exists(NOTE), what="the protection note")
            text = self.driver.get_text(NOTE).strip()
            tone = self.driver.get_attribute(NOTE, "data-tone")
            self.evidence(f"note ({tone}): {text!r}")
            assert "OS-enforced:" not in text, f"the old note is back: {text!r}"
            if tone == "info":
                assert text.startswith(OS_ENFORCED_PREFIX), f"unexpected OS-enforced note: {text!r}"
            else:
                assert tone == "warning", f"unexpected note tone {tone!r}"
                assert text.startswith(APP_PROTECTED_TEXT), f"unexpected note: {text!r}"
