"""Credential-store system tests (issue #857).

Exercises the master-password credential store end-to-end through the bridge
harness — the subsystem previously covered only by Rust unit tests and manual
tests. Enabled by the ``CredentialStoreUi`` mixin (#851), which drives the
Settings → Security panel and the status-bar lock indicator the way a user does.

Covered:
- the indicator is hidden in ``none`` mode and shown in master-password mode,
- master-password mode persists across an app restart (and re-locks),
- a wrong master password surfaces an error and clears the field (store stays
  locked), and Skip dismisses the dialog without unlocking,
- a saved password is reused on reconnect (no second prompt),
- a locked store raises the unlock dialog before a connect proceeds.

Extends the original WebdriverIO ``credential-store.test.js`` (#838): that suite
ran most of its scenarios only when the host machine happened to be in
master-password mode, whereas the harness drives the store into that mode itself.

The password-auth SSH container (port 2201) backs the connect-based scenarios.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    CredentialStoreUi,
    PasswordPromptUi,
    SETTINGS_REGION,
    SettingsUi,
    SidebarUi,
    SSH_HOST,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

MASTER_PASSWORD = "system-test-master-pw"


@pytest.mark.usefixtures("ssh_fixtures")
class TestCredentialStore(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    PasswordPromptUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    def test_indicator_hidden_in_none_mode(self):
        # Runs first, before any store is set up: the app launches in "none" mode,
        # where the status-bar credential indicator must not render (it is a
        # master-password-only control). Asserts the current mode is none too.
        status = self.wait(self.credential_store_status, what="the credential status")
        assert status["mode"] == "none"
        assert not self.credential_indicator_present()

    def test_indicator_shown_in_master_password_mode(self):
        # Once a master-password store is active the indicator renders and reports a
        # lock state. (setup is a no-op if an earlier test already set it up.)
        self.setup_master_password_store(MASTER_PASSWORD)
        self.wait(self.credential_indicator_present, what="the credential indicator")
        assert "lock" in self.driver.get_text("credential-store-indicator").lower()

    def test_wrong_master_password_shows_error_and_clears(self):
        # A wrong password at the unlock dialog surfaces an error and clears the
        # field for a retry, leaving the store locked. Then unlock properly so the
        # following tests start from an unlocked store.
        self.setup_master_password_store(MASTER_PASSWORD)
        self.lock_credential_store()
        self.open_unlock_dialog()

        self.driver.type("unlock-dialog-input", "definitely-the-wrong-password")
        self.driver.click("unlock-dialog-unlock")
        self.wait(
            lambda: self.driver.exists("unlock-dialog-error"),
            what="the wrong-password error",
        )
        assert self.driver.get_value("unlock-dialog-input") == ""
        assert self.credential_store_locked()

        self.handle_unlock_dialog(MASTER_PASSWORD)
        assert self.credential_store_unlocked_master_password()

    def test_skip_unlock_keeps_store_locked(self):
        # Clicking Skip dismisses the unlock dialog but leaves the store locked.
        # Restore an unlocked store afterward for the later change-password test.
        self.setup_master_password_store(MASTER_PASSWORD)
        self.lock_credential_store()
        self.open_unlock_dialog()

        self.driver.click("unlock-dialog-skip")
        self.wait(
            lambda: not self.driver.exists("unlock-dialog-input"),
            what="the unlock dialog to close",
        )
        assert self.credential_store_locked()

        self.unlock_credential_store(MASTER_PASSWORD)

    def test_master_password_mode_persists_and_relocks_across_restart(self):
        # Switching to a master-password store writes the mode to settings and the
        # vault to disk; both must survive a restart. The store starts locked after
        # a restart (the password is not on disk), and unlocking with the same
        # password proves the vault persisted intact.
        self.setup_master_password_store(MASTER_PASSWORD)
        assert self.credential_store_unlocked_master_password()

        self.restart_app()

        status = self.wait(
            lambda: self.credential_store_status(), what="the credential status after restart"
        )
        assert status["mode"] == "master_password"
        self.wait(self.credential_store_locked, what="the store to be locked after restart")

        # The persisted vault still opens with the original password.
        self.unlock_credential_store(MASTER_PASSWORD)
        assert self.credential_store_unlocked_master_password()

    def test_saved_password_is_reused_on_reconnect(self):
        # With an active store the password prompt's "Save password" box defaults on,
        # so the first connect stores the credential. The second connect must resolve
        # it from the store and land in a terminal without prompting again.
        self.setup_master_password_store(MASTER_PASSWORD)
        name = unique_name("cred-reuse")
        self.create_ssh_connection(
            name,
            host=SSH_HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=False,
        )
        # Wait for the id to settle before connecting: the credential is stored under
        # the connection id, which can change across the post-save disk reloads.
        self.require_stable_connection(name)

        # First connect: answer (and store) the password prompt, then land in a shell.
        self.connect_connection(name)
        self.handle_password_prompt()
        first = self.wait(lambda: self.find_tab(name), what="the first SSH tab")
        self.wait(self.has_terminal, what="the first SSH terminal session")

        # Close that tab so the reconnect opens a fresh session.
        self.close_tab(first["id"])
        self.wait(lambda: self.find_tab(name) is None, what="the first tab to close")

        # Second connect: the stored credential resolves, so no prompt is raised.
        self.connect_connection(name)
        self.wait(lambda: self.find_tab(name), what="the reconnected SSH tab")
        self.wait(self.has_terminal, what="the reconnected SSH terminal session")
        assert not self.password_prompt_open()

    def test_locked_store_prompts_unlock_before_connect(self):
        # Locking the store mid-session means the next connect cannot read stored
        # credentials, so it must raise the unlock dialog first; unlocking lets the
        # connect proceed (here to the password prompt, since the connection is new).
        self.setup_master_password_store(MASTER_PASSWORD)
        name = unique_name("cred-unlock")
        self.create_ssh_connection(
            name,
            host=SSH_HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=False,
        )
        self.require_connection(name)

        self.lock_credential_store()
        self.connect_connection(name)

        # The locked store raises the unlock dialog before any credential resolution.
        self.handle_unlock_dialog(MASTER_PASSWORD)
        # With the store unlocked and no stored credential yet, the connect falls
        # through to the password prompt; answering it lands in a terminal.
        self.handle_password_prompt()
        self.wait(lambda: self.find_tab(name), what="the unlocked SSH tab")
        self.wait(self.has_terminal, what="the SSH terminal session after unlock")

    def test_stale_stored_credential_is_recovered(self):
        # A saved-but-wrong password is detected on the next connect (auth fails),
        # cleared, and the user is re-prompted; the corrected password then connects.
        self.setup_master_password_store(MASTER_PASSWORD)
        name = unique_name("cred-stale")
        self.create_ssh_connection(
            name,
            host=SSH_HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=False,
        )
        self.require_stable_connection(name)

        # First connect stores a wrong password (the save box defaults on); the
        # session fails to authenticate, leaving a (disconnected/error) tab.
        self.connect_connection(name)
        self.handle_password_prompt("definitely-the-wrong-password")
        bad = self.wait(lambda: self.find_tab(name), what="the failed SSH tab")
        self.close_tab(bad["id"])
        self.wait(lambda: self.find_tab(name) is None, what="the failed tab to close")

        # Reconnect: the stale credential is tried, auth fails, it is cleared, and
        # the password prompt is raised again — answer it correctly this time.
        self.connect_connection(name)
        self.handle_password_prompt()
        self.wait(lambda: self.find_tab(name), what="the recovered SSH tab")
        self.wait(self.has_terminal, what="the SSH terminal session after recovery")

    def test_disabled_save_does_not_store_and_reprompts(self):
        # The inverse of test_saved_password_is_reused_on_reconnect, and the last
        # behavior the old credential-store-infra.test.js (CRED-06) still covered:
        # when the user unchecks the (default-on) "Save password" box, nothing is
        # written to the store, so the next connect must prompt again.
        self.setup_master_password_store(MASTER_PASSWORD)
        name = unique_name("cred-nosave")
        self.create_ssh_connection(
            name,
            host=SSH_HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=False,
        )
        self.require_stable_connection(name)

        # First connect: uncheck the save box before answering, so the credential
        # is never stored, then land in a shell.
        self.connect_connection(name)
        self.wait(
            lambda: self.driver.exists("password-prompt-save-checkbox"),
            what="the save-password toggle",
        )
        self.driver.click("password-prompt-save-checkbox")  # default on → off
        self.handle_password_prompt()
        first = self.wait(lambda: self.find_tab(name), what="the first SSH tab")
        self.wait(self.has_terminal, what="the first SSH terminal session")

        self.close_tab(first["id"])
        self.wait(lambda: self.find_tab(name) is None, what="the first tab to close")

        # Second connect: no stored credential, so the prompt reappears.
        self.connect_connection(name)
        self.wait(self.password_prompt_open, what="the password prompt on reconnect")
        self.cancel_password_prompt()

    def test_auto_lock_timeout_setting_persists(self):
        # The auto-lock options start at 5 minutes, so the lock firing cannot be
        # awaited in a system test (covered by manual test MT-CRED-04). This verifies
        # the selected timeout round-trips into the store, then resets it to Never.
        self.setup_master_password_store(MASTER_PASSWORD)
        self.set_auto_lock_timeout(5)
        assert (
            self.projection_region_cache(SETTINGS_REGION).get("credentialAutoLockMinutes")
            == 5
        )
        self.set_auto_lock_timeout(0)

    def test_change_master_password(self):
        # Changing the master password re-encrypts the vault; the new password must
        # then open it. Lock and unlock with the new password to prove it took, then
        # restore the baseline so later tests are unaffected.
        self.setup_master_password_store(MASTER_PASSWORD)
        new_password = MASTER_PASSWORD + "-changed"
        self.change_master_password(MASTER_PASSWORD, new_password)
        assert self.credential_store_unlocked_master_password()

        self.lock_credential_store()
        self.unlock_credential_store(new_password)
        assert self.credential_store_unlocked_master_password()

        self.change_master_password(new_password, MASTER_PASSWORD)

    def test_migrate_master_password_store_to_none(self):
        # Switching back to no-storage migrates the credentials to the null backend
        # and reports a migration result. Runs last because it leaves the store in
        # "none" mode. (setup_master_password_store no-ops while already unlocked.)
        self.setup_master_password_store(MASTER_PASSWORD)
        self.migrate_to_no_store()
        status = self.wait(
            lambda: self.credential_store_status(), what="the credential status"
        )
        assert status["mode"] == "none"
