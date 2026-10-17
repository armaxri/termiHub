"""Guided-manual credential-store checks against the real OS stores (#913).

Ported from the retired ``tests/manual/credential-store.yaml``. Each item needs
the real OS credential store or a system authentication sheet (Keychain
Access, Credential Manager, Secret Service, Touch ID, Windows Hello, polkit),
which the in-webview bridge cannot see or answer. The harness does the in-app
part: it switches the store mode, saves a password through the real SSH
password prompt, and opens the Security / Backup settings. The operator then
answers the system sheet or looks in the OS store.

The saved-credential *behaviour* (round-trips, re-prompt, removal, auto-lock)
is automated in ``test_credential_store.py`` and the vault export/import
round-trip in ``test_native_dialogs.py``.

Covered: MT-CRED-01/02/03 (secret lands in the OS store), MT-CRED-11/13/14
(system authentication for keychain export/backup), MT-CRED-12/15/16
(biometric unlock of the master-password store), MT-CRED-17 (unlock and
password dialog spacing) and MT-CRED-18 (backup restore of keychain
credentials across the startup swap).

Run with ``./pytest.sh --manual -k guided_credentials -s``.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    CredentialStoreUi,
    ManualUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

_MASTER_PASSWORD = "guided-master-pw-913"
_SSH_SECRET = "guided-ssh-secret-913"


class TestGuidedCredentials(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    SidebarUi,
    SettingsUi,
    CredentialStoreUi,
    PasswordPromptUi,
    ManualUi,
    SystemTest,
):
    """Harness switches the store and saves a secret; operator checks the OS side."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _store_mode(self) -> str:
        return str((self.credential_store_status() or {}).get("mode") or "")

    def _use_os_keychain(self) -> None:
        """Switch the store to the OS keychain mode through Settings > Security."""
        if self._store_mode() == "os_keychain":
            return
        self.open_settings_category("security")
        self.wait(
            lambda: self.driver.exists("storage-mode-os-keychain"),
            what="the storage-mode options",
        )
        self.driver.click("storage-mode-os-keychain")
        self.wait(
            lambda: self.driver.exists("confirm-switch-confirm-btn"),
            what="the switch confirm dialog",
        )
        self.driver.click("confirm-switch-confirm-btn")
        self.wait(lambda: self._store_mode() == "os_keychain", what="the OS keychain mode")

    def _save_ssh_password(self, label: str) -> str:
        """Save a password for a (server-less) SSH connection via the real prompt.

        The prompt persists the secret the moment it is answered, before the
        connect to port 1 fails, so no SSH server is needed.
        """
        name = unique_name(label)
        self.create_ssh_connection(
            name, host="127.0.0.1", port=1, username="guided", auth_method="password"
        )
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        self.wait(lambda: self.driver.exists("password-prompt-input"), what="the password prompt")
        self.driver.type("password-prompt-input", _SSH_SECRET)
        checkbox = "password-prompt-save-checkbox"
        self.wait(lambda: self.driver.exists(checkbox), what="the Save password box")
        if self.driver.get_attribute(checkbox, "aria-checked") != "true":
            self.driver.click(checkbox)
        self.driver.click("password-prompt-connect")
        self.close_all_tabs()
        return name

    def _keychain_with_one_secret(self, label: str) -> str:
        self.close_all_tabs()
        self._use_os_keychain()
        return self._save_ssh_password(label)

    # ── MT-CRED-01/02/03: the secret lands in the OS store ───────────────────
    @pytest.mark.manual(platforms=["windows"])
    def test_windows_credential_manager_holds_the_secret(self):
        """MT-CRED-01."""
        name = self._keychain_with_one_secret("cred-wincm")
        self.manual_step(
            f"The harness saved a password for {name!r} in OS Keychain mode. Open "
            "Control Panel > Credential Manager > Windows Credentials (or run "
            "`cmdkey /list`) and search for termiHub.",
            "A generic credential under the termiHub target exists for the connection.",
        )

    @pytest.mark.manual(platforms=["macos"])
    def test_macos_keychain_holds_the_secret(self):
        """MT-CRED-02."""
        name = self._keychain_with_one_secret("cred-keychain")
        self.manual_step(
            f"The harness saved a password for {name!r} in OS Keychain mode. Open "
            "Keychain Access and search for termiHub.",
            "An entry with service termiHub and account '<connection-id>:password' exists.",
        )

    @pytest.mark.manual(platforms=["linux"])
    def test_linux_secret_service_holds_the_secret(self):
        """MT-CRED-03."""
        name = self._keychain_with_one_secret("cred-secretsvc")
        self.manual_step(
            f"The harness saved a password for {name!r} in OS Keychain mode. Run "
            "`secret-tool search service termiHub` (or open Seahorse / KWallet).",
            "The stored secret for the connection is listed.",
        )

    # ── MT-CRED-11/13/14: system authentication for keychain export ──────────
    @pytest.mark.manual(platforms=["macos"])
    def test_macos_keychain_export_asks_touch_id_every_time(self):
        """MT-CRED-11."""
        self._keychain_with_one_secret("cred-touchid-export")
        self.open_settings_category("security")
        self.manual_step(
            "In Settings > Security click Export vault…, enter a passphrase, touch the "
            "sensor and save. Export again and click Cancel in the system sheet. Export "
            "once more and choose Use Password… with your login password. Then Settings "
            "> Backup > Back up everything… with Credentials, confirming with Touch ID.",
            "A system sheet appears on every export and backup; Touch ID or the login "
            "password lets the save go through; Cancel shows 'System authentication was "
            "cancelled' and writes no file.",
        )

    @pytest.mark.manual(platforms=["windows"])
    def test_windows_hello_export_and_unlock(self):
        """MT-CRED-13."""
        self._keychain_with_one_secret("cred-hello-export")
        self.open_settings_category("security")
        self.manual_step(
            "Click Export vault…, verify in the Windows Hello dialog and save. Then "
            "Settings > Backup > Back up everything… with Credentials and verify.",
            "The Hello dialog appears in front of termiHub each time and both saves succeed.",
        )
        self.setup_master_password_store(_MASTER_PASSWORD)
        self.open_settings_category("security")
        self.manual_step(
            "The store is now in Master Password mode. Turn on Unlock with Windows Hello, "
            "lock the store (status bar lock), unlock with Hello. Lock again, cancel the "
            f"Hello dialog once and unlock with the master password {_MASTER_PASSWORD!r}.",
            "Hello unlocks the store; Cancel writes nothing and the master-password "
            "fallback works.",
        )

    @pytest.mark.manual(platforms=["linux"])
    def test_linux_polkit_dialog_for_keychain_export(self):
        """MT-CRED-14 (run once on GNOME and once on KDE Plasma, installed .deb/.rpm)."""
        self._keychain_with_one_secret("cred-polkit-export")
        self.open_settings_category("security")
        self.manual_step(
            "Click Export vault…, enter your own password in the polkit dialog and save. "
            "Export again and click Cancel in the polkit dialog. Then Settings > Backup > "
            "Back up everything… with Credentials and authenticate.",
            "The desktop polkit dialog asks every time; export and backup save after "
            "authenticating; Cancel shows 'System authentication was cancelled' and "
            "writes no file.",
        )

    # ── MT-CRED-12/15/16: biometric unlock of the master-password store ──────
    def _master_password_store_with_security_open(self) -> None:
        self.close_all_tabs()
        self.setup_master_password_store(_MASTER_PASSWORD)
        self._save_ssh_password("cred-bio")
        self.open_settings_category("security")
        self.wait(
            lambda: self.driver.exists("biometric-unlock-settings"),
            what="the biometric unlock settings",
        )

    @pytest.mark.manual(platforms=["macos"])
    def test_macos_touch_id_unlock_of_master_password_store(self):
        """MT-CRED-12."""
        self._master_password_store_with_security_open()
        self.manual_step(
            "Turn on Unlock with Touch ID and confirm with Touch ID. Lock the store, "
            "connect the saved connection and touch the sensor. Lock again and choose "
            f"Use Master Password ({_MASTER_PASSWORD!r}). Add a fingerprint in System "
            "Settings, then lock and unlock again.",
            "Touch ID unlocks and the connection proceeds; the master-password fallback "
            "works; after the fingerprint change the app says biometric unlock was "
            "turned off; an unsigned build shows 'OS-enforced: no' under the toggle.",
        )

    @pytest.mark.manual(platforms=["macos"])
    def test_macos_os_enforced_biometric_key_on_signed_build(self):
        """MT-CRED-15 (needs a code-signed build with keychain-access-groups)."""
        self._master_password_store_with_security_open()
        self.manual_step(
            "On a signed build: turn on Unlock with Touch ID, lock and unlock with Touch "
            "ID. With an enrollment made by an unsigned build, install the signed build "
            "and unlock once. Add a fingerprint in System Settings, lock and unlock again.",
            "Settings shows 'OS-enforced: yes' and unlock shows one Touch ID sheet; the "
            "upgraded enrollment shows 'OS-enforced: yes'; after the fingerprint change "
            "the app says biometric unlock was turned off.",
        )

    @pytest.mark.manual(platforms=["windows"])
    def test_windows_hello_os_enforced_biometric_key(self):
        """MT-CRED-16 (an enrolled Windows Hello device)."""
        self._master_password_store_with_security_open()
        self.manual_step(
            "Turn on Unlock with Windows Hello and confirm each Hello dialog. Lock the "
            "store and unlock with Hello. Lock again and cancel the Hello dialog.",
            "Every Hello dialog is in front of termiHub; Settings shows 'OS-enforced: "
            "yes'; unlock shows one dialog; Cancel keeps the store locked and the master "
            "password still works.",
        )

    # ── MT-CRED-17: unlock and password dialog spacing ───────────────────────
    def test_unlock_and_password_dialogs_keep_text_field_and_links_apart(self):
        """MT-CRED-17."""
        self.close_all_tabs()
        self.setup_master_password_store(_MASTER_PASSWORD)
        self.restart_app()
        self.wait(self.credential_store_locked, what="the store to be locked after restart")
        self.open_unlock_dialog()
        self.manual_step(
            "In Unlock Credential Store click into the password field, then type a wrong "
            "password and click Unlock.",
            "The two-line description sits above the labelled field with a clear gap; the "
            "focus ring touches neither the description nor 'Forgot password?'; the error "
            "is its own line between the field and the reset link.",
        )
        self.handle_unlock_dialog(_MASTER_PASSWORD)
        name = unique_name("cred-spacing")
        self.create_ssh_connection(
            name, host="127.0.0.1", port=1, username="guided", auth_method="password"
        )
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        self.wait(lambda: self.driver.exists("password-prompt-input"), what="the password prompt")
        self.manual_observe(
            "Look at the SSH Password prompt the harness opened.",
            "It shows the same clear gap between its text and the field.",
        )
        self.cancel_password_prompt()

    # ── MT-CRED-18: backup restore of keychain credentials ───────────────────
    @pytest.mark.manual(platforms=["macos", "windows", "linux"])
    def test_backup_restore_imports_keychain_credentials_after_startup_swap(self):
        """MT-CRED-18."""
        name = self._keychain_with_one_secret("cred-restore")
        self.open_settings_category("backup")
        self.manual_step(
            f"Back up everything… with Credentials. Change the saved password of {name!r}, "
            "then Restore… the backup with a section and Credentials (Overwrite) and "
            "click Restore and restart.",
            "The app restarts (the harness follows it next).",
        )
        self.adopt_app_self_restart(timeout=120.0)
        self.manual_step(
            f"Connect {name!r} and search the OS store for 'termiHub-backup-restore' "
            "(Keychain Access / Credential Manager / `secret-tool search service "
            "termiHub-backup-restore`).",
            "The backup's password is used with no warning; no 'termiHub-backup-restore' "
            "entry is left.",
        )
        self.manual_step(
            f"Lock macros.json in {self.config_dir} (macOS `chflags uchg`; Linux `sudo "
            "chattr +i`; Windows hold it open with [IO.File]::Open(path,'Open','Read',"
            "'None')), restore again and click Restore and restart.",
            "The app restarts (the harness follows it next).",
        )
        self.adopt_app_self_restart(timeout=120.0)
        self.manual_step(
            "Check the startup notice, then unlock the file again (chflags nouchg / "
            "chattr -i / close PowerShell) and search the OS store once more.",
            "The restart warned 'Restoring the backup failed. Your previous data was kept "
            "unchanged.'; the password is unchanged and no seal-key entry remains.",
        )
