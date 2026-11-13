"""Product run: credential-store feedback states (#5629).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The UI review of run ``20261113T080834Z`` found:

1. **One confirmation**: switching storage showed "Switched to Master
   password." twice at once, as the inline banner and as a toast.
2. **Unlock error state**: after a wrong master password the Unlock button
   flashed the green success outline and the password field kept its focus
   border instead of an error state.
3. **Named switch confirmation**: the switch to the OS Keychain offered a
   generic "Confirm", did not say what happens to the master-password vault
   and named the target two ways ("OS Keychain", "OS credential store").

No sshd and no keychain write: the store is set up from Settings ▸ Security,
the unlock dialog is opened from the status-bar lock, and the keychain switch
confirmation is read and then cancelled.
"""

from __future__ import annotations

import time

import pytest

from termihub_harness import (
    ConnectionsUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

MASTER_PASSWORD = "product-run-feedback-pw"
WRONG_PASSWORD = "not-the-feedback-pw"
#: Longer than the Button's success flash, so a flash would still be visible.
SETTLE = 0.3
TOAST_REGION = "toast-region"


class TestProductRunCredentialFeedback(
    ProductRunUi,
    ConnectionsUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    phase = "Credential feedback"
    request_timeout = 90.0

    def _classes(self, test_id: str) -> list[str]:
        return (self.driver.get_attribute(test_id, "class") or "").split()

    def test_10_switch_confirmed_once(self):
        with self.step(
            "cred-feedback.switch-once",
            "Switching to a master password confirms it once, inline, not also as a toast (#5629)",
            expect="#5629: Settings ▸ Security with one 'Switched to Master password.' banner "
            "and no toast saying the same",
        ):
            status = self.wait(self.credential_store_status, what="the credential store status")
            if status.get("mode") != "none":
                pytest.skip(f"the profile already has a store ({status.get('mode')!r})")
            self.open_settings_category("security")
            self.wait(lambda: self.driver.exists("storage-mode-master-password"), what="options")
            self.driver.click("storage-mode-master-password")
            self.wait(lambda: self.driver.exists("master-password-input"), what="the setup form")
            label = self.driver.get_text("master-password-confirm-btn").strip()
            self.evidence(f"setup button: {label!r}")
            assert label != "Confirm", "the setup button is a generic 'Confirm'"
            self.driver.type("master-password-input", MASTER_PASSWORD)
            self.driver.type("master-password-confirm-input", MASTER_PASSWORD)
            self.driver.click("master-password-confirm-btn")
            self.wait(self.credential_store_unlocked_master_password, what="the unlocked store")
            self.wait(lambda: self.driver.exists("migration-result"), what="the switch banner")
            banner = self.driver.get_text("migration-result")
            toasts = self.driver.get_text(TOAST_REGION) if self.driver.exists(TOAST_REGION) else ""
            self.evidence(f"banner {banner!r}; toasts {toasts!r}")
            assert "Switched to" in banner, banner
            assert "Switched to" not in toasts, f"the switch is confirmed twice: {toasts!r}"

    def test_20_wrong_password_error_state(self):
        with self.step(
            "cred-feedback.unlock.wrong-password",
            "A wrong master password marks the field invalid; Unlock stays the primary button",
            expect="#5629: the unlock dialog with a red-bordered password field, the error under "
            "it and a filled blue Unlock button (no green outline)",
        ):
            self.require("cred-feedback.switch-once")
            self.lock_credential_store()
            self.open_unlock_dialog()
            self.driver.type("unlock-dialog-input", WRONG_PASSWORD)
            self.driver.click("unlock-dialog-unlock")
            self.wait(lambda: self.driver.exists("unlock-dialog-error"), what="the unlock error")
            time.sleep(SETTLE)
            unlock = self._classes("unlock-dialog-unlock")
            field = self._classes("unlock-dialog-input")
            invalid = self.driver.get_attribute("unlock-dialog-input", "aria-invalid")
            self.evidence(f"unlock classes {unlock}; input classes {field}; aria-invalid {invalid}")
            assert "ui-btn--primary" in unlock, unlock
            assert "ui-btn--success" not in unlock, "Unlock flashed the success state on a failure"
            assert invalid == "true", "the password field is not marked invalid"
            assert "ui-input--error" in field, "the password field has no error border"
            assert self.credential_store_locked(), "a wrong password unlocked the store"
            self.handle_unlock_dialog(MASTER_PASSWORD)

    def test_30_keychain_switch_confirmation(self):
        with self.step(
            "cred-feedback.keychain.confirm",
            "The switch to the OS Keychain names the move and says what happens to the vault",
            expect="#5629: 'Move saved credentials to OS Keychain?' with a 'Move to OS Keychain' "
            "button and a line saying the master-password vault is kept",
        ):
            self.require("cred-feedback.switch-once")
            self.wait(self.credential_store_unlocked_master_password, what="the unlocked store")
            self.open_settings_category("security")
            self.wait(lambda: self.driver.exists("storage-mode-os-keychain"), what="options")
            self.driver.click("storage-mode-os-keychain")
            self.wait(lambda: self.driver.exists("confirm-switch-dialog"), what="the confirmation")
            text = self.driver.get_text("confirm-switch-dialog")
            action = self.driver.get_text("confirm-switch-confirm-btn").strip()
            self.evidence(f"confirmation {text!r}; action {action!r}")
            try:
                assert action == "Move to OS Keychain", action
                assert "vault" in text, "the confirmation does not say what happens to the vault"
                assert "credential store" not in text.lower(), "the target is named two ways"
            finally:
                self.driver.click("confirm-switch-cancel-btn")
            self.wait(lambda: not self.driver.exists("confirm-switch-dialog"), what="cancelled")
            assert self.store_mode_is_master_password(), "cancelling switched the store"

    def store_mode_is_master_password(self) -> bool:
        status = self.credential_store_status() or {}
        return status.get("mode") == "master_password"

    def test_50_unlock_names_connection(self):
        """The unlock dialog a connect raises names that connect (#5684).

        The status-bar unlock keeps the generic text. No sshd: the connect is
        cancelled on the unlock dialog before anything connects.
        """
        name = unique_name("pr-unlock-names")
        with self.step(
            "cred-feedback.unlock.names-connection",
            "The unlock dialog raised by a connect names the waiting connection (#5684)",
            expect=f"#5684: the unlock dialog says 'Unlock to connect to {name} (SSH) with its "
            "saved password.'; the status-bar unlock shows no such line",
        ):
            self.require("cred-feedback.switch-once")
            if self.credential_store_locked():
                self.unlock_credential_store(MASTER_PASSWORD)
            self.switch_to_connections_sidebar()
            # Never connected: the unlock dialog is closed first.
            self.create_ssh_connection(
                name, host="127.0.0.1", port=1, username="nobody", save_password=True
            )
            self.require_connection(name)
            self.lock_credential_store()

            # The plain unlock from the status bar names nothing.
            self.open_unlock_dialog()
            plain = self.driver.exists("unlock-dialog-waiting")
            self.driver.click("modal-close")
            self.wait(lambda: not self.driver.exists("unlock-dialog-input"), what="closed")

            self.connect_connection(name)
            self.wait(lambda: self.driver.exists("unlock-dialog-waiting"), what="the waiting line")
            try:
                line = self.driver.get_text("unlock-dialog-waiting").strip()
                self.evidence(f"status-bar unlock names a connect: {plain}; connect line {line!r}")
                assert not plain, "the status-bar unlock names a waiting connection"
                assert line == f"Unlock to connect to {name} (SSH) with its saved password.", line
            finally:
                self.driver.click("modal-close")
            self.wait(lambda: not self.driver.exists("unlock-dialog-input"), what="cancelled")

