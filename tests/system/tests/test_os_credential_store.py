"""The real OS credential store, checked from the harness (#4929).

Until #4929 these were guided-manual checks: the operator opened Keychain
Access, Credential Manager or ``secret-tool`` and looked for the item. The
harness now reads the store itself through :mod:`termihub_harness.os_store`,
always in a throwaway store (a temporary macOS keychain, a private
gnome-keyring) or, on Windows, under run-unique items it deletes again. The
user's real secrets are never read or written.

Covered:

- MT-CRED-01/02/03: a password saved in OS-keychain mode lands in the OS store
  under service ``termiHub`` and account ``<connection-id>:password``, and
  deleting the connection removes it again.
- MT-CRED-18: a backup restore imports its credentials into the OS store after
  the startup swap and leaves no ``termiHub-backup-restore`` seal key behind;
  when the swap fails (a restored file is locked), the startup notice says the
  data was kept unchanged, nothing is imported and no seal key is left.

The secret's value is compared on Linux and Windows. On macOS reading a secret
the app wrote raises a keychain access prompt, so the item's presence is
checked instead; the deferred import itself is covered value-for-value by the
Rust real-keychain tests (``src-tauri/src/backup/tests_real_keychain.rs``).

The Rust real-keychain tests prove the store code against each OS store; this
suite proves the built app, driven through its UI, ends up with the right items.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Optional

import pytest

from termihub_harness import (
    ConfigRecoveryUi,
    ConnectionsUi,
    CredentialStoreUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.locked_file import LockUnavailable, locked
from termihub_harness.os_store import SEAL_SERVICE, credential_account

pytestmark = pytest.mark.integration

_MASTER_PASSWORD = "os-store-master-pw-4929"
_SECRET = "os-store-ssh-secret-4929"
#: The passphrase sealing the backup (the dialog's minimum is 12 characters).
_PASSPHRASE = "os-store-backup-pw-4929"
#: The restored file locked to make the startup swap fail.
_LOCKED_FILE = "connections.json"
_UNCHANGED = "Your previous data was kept unchanged."


class TestOsCredentialStore(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    SidebarUi,
    SettingsUi,
    CredentialStoreUi,
    PasswordPromptUi,
    ConfigRecoveryUi,
    SystemTest,
):
    """Save, back up and restore credentials; read the OS store directly."""

    os_credential_store = True

    #: The sealed backup the restore tests share: (file, connection, account).
    _backup: Optional[tuple[Path, str, str]] = None

    def reset_before_rerun(self) -> None:
        self.dismiss_modals(
            "unlock-dialog-skip", self.RECOVERY_DIALOG, "backup-restore-title"
        )
        self.close_all_tabs()

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _store_mode(self) -> str:
        return str((self.credential_store_status() or {}).get("mode") or "")

    def _use_os_keychain(self) -> None:
        """Switch the store to OS-keychain mode (migrating) through Settings > Security."""
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
        self.switch_to_connections_sidebar()

    def _save_password(self, label: str) -> tuple[str, str]:
        """Save ``_SECRET`` for a new (server-less) SSH connection via the real prompt.

        The prompt persists the secret the moment it is answered, before the
        connect to port 1 fails, so no SSH server is needed. Returns the
        connection name and its OS-store account.
        """
        name = unique_name(label)
        self.create_ssh_connection(
            name, host="127.0.0.1", port=1, username="os-store", auth_method="password"
        )
        account = credential_account(self.require_stable_connection(name)["id"])
        self.os_store.track(account)
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        self.wait(lambda: self.driver.exists("password-prompt-input"), what="the password prompt")
        self.driver.type("password-prompt-input", _SECRET)
        checkbox = "password-prompt-save-checkbox"
        self.wait(lambda: self.driver.exists(checkbox), what="the Save password box")
        if self.driver.get_attribute(checkbox, "aria-checked") != "true":
            self.driver.click(checkbox)
        self.driver.click("password-prompt-connect")
        self.close_all_tabs()
        return name, account

    def _delete_connection(self, name: str) -> None:
        self.switch_to_connections_sidebar()
        self.connection_context_action(name, self.CTX_DELETE)
        self.wait(lambda: self.find_connection(name) is None, what=f"{name!r} to be deleted")

    def _assert_in_os_store(self, account: str) -> None:
        """Wait until the OS store holds ``account`` with ``_SECRET`` (where readable)."""
        store = self.os_store
        self.wait(
            lambda: store.exists(account),
            what=f"{account!r} in the {store.name} (holds: {sorted(store.accounts())})",
        )
        if store.reads_values:
            assert store.value(account) == _SECRET, f"wrong secret stored for {account!r}"

    def _assert_not_in_os_store(self, account: str) -> None:
        store = self.os_store
        self.wait(lambda: not store.exists(account), what=f"{account!r} gone from {store.name}")

    def _assert_no_new_seal_keys(self, before: set[str]) -> None:
        self.wait(
            lambda: not (self.os_store.accounts(SEAL_SERVICE) - before),
            what=f"no {SEAL_SERVICE!r} seal key left in the {self.os_store.name}",
        )

    def _toggle_on(self, test_id: str) -> None:
        self.wait(lambda: self.driver.exists(test_id), what=test_id)
        if self.driver.get_attribute(test_id, "aria-checked") != "true":
            self.driver.click(test_id)
        assert self.driver.get_attribute(test_id, "aria-checked") == "true", test_id

    def _back_up_with_credentials(self, target: Path) -> None:
        """Back up connections + credentials of the master-password store."""
        self.open_settings_category("backup")
        self.wait(lambda: self.driver.exists("backup-export-btn"), what="the Back up button")
        self.driver.click("backup-export-btn")
        self.wait(
            lambda: self.driver.exists("backup-export-section-connections"),
            what="the backup sections to load",
        )
        self._toggle_on("backup-export-section-connections")
        self._toggle_on("backup-export-credentials")
        self.wait(
            lambda: self.driver.exists("backup-export-master-password"),
            what="the master password field",
        )
        self.driver.type("backup-export-master-password", _MASTER_PASSWORD)
        self.driver.type("backup-export-passphrase", _PASSPHRASE)
        self.driver.type("backup-export-confirm", _PASSPHRASE)
        self.driver.stub_native_dialog("save", target)
        self.driver.click("backup-export-submit")
        self.wait(
            lambda: target.exists() and target.stat().st_size > 0,
            what=f"the backup to be written to {target}",
        )
        self.wait(
            lambda: not self.driver.exists("backup-export-title"),
            what="the backup dialog to close after saving",
        )

    def _restore_with_credentials(self, target: Path) -> None:
        """Restore connections + credentials from ``target``, then Restore and restart."""
        self.open_settings_category("backup")
        self.wait(lambda: self.driver.exists("backup-restore-btn"), what="the Restore button")
        self.driver.click("backup-restore-btn")
        self.wait(
            lambda: self.driver.exists("backup-restore-choose-file"), what="the restore dialog"
        )
        self.driver.stub_native_dialog("open", target)
        self.driver.click("backup-restore-choose-file")
        self.wait(
            lambda: self.driver.get_text("backup-restore-file-name") == target.name,
            what="the picked backup to be read",
        )
        self.driver.type("backup-restore-passphrase", _PASSPHRASE)
        self.driver.click("backup-restore-preview")
        self.wait(
            lambda: self.driver.exists("backup-restore-preview-panel"), what="the restore preview"
        )
        self._toggle_on("backup-restore-include-connections")
        self._toggle_on("backup-restore-include-credentials")
        detail = self.driver.get_text("backup-restore-credentials-detail")
        assert "1 in backup" in detail, f"unexpected credentials preview: {detail!r}"
        self.driver.click("backup-restore-submit")
        # "Restore and restart": the app relaunches itself to apply the restore.
        self.adopt_app_self_restart(timeout=120.0)

    def _prepare_backup(self) -> tuple[Path, str, str]:
        """A sealed backup holding one saved password, with the store then in OS mode.

        The backup is made in master-password mode, because a backup with
        credentials from the OS keychain asks the OS to verify the user (Touch
        ID / Windows Hello / polkit), which no CI runner can answer. The switch
        to OS-keychain mode afterwards migrates the password into the OS store.
        """
        if type(self)._backup is not None:
            return type(self)._backup
        self.close_all_tabs()
        self.setup_master_password_store(_MASTER_PASSWORD)
        name, account = self._save_password("os-store-restore")
        target = Path(tempfile.mkdtemp(prefix="thub-os-store-backup-")) / "backup.json"
        self._back_up_with_credentials(target)
        self._use_os_keychain()
        self._assert_in_os_store(account)
        type(self)._backup = (target, name, account)
        return type(self)._backup

    # ── MT-CRED-01/02/03 ─────────────────────────────────────────────────────
    def test_saved_password_lands_in_the_os_credential_store(self):
        """MT-CRED-01 (Windows Credential Manager), MT-CRED-02 (macOS Keychain),
        MT-CRED-03 (Linux Secret Service).

        In OS-keychain mode the harness saves a password through the real SSH
        password prompt and reads the OS store: an item with service
        ``termiHub`` and account ``<connection-id>:password`` holds the secret.
        Deleting the connection removes the item again.
        """
        self.close_all_tabs()
        self._use_os_keychain()
        name, account = self._save_password("os-store-save")
        self._assert_in_os_store(account)
        self._delete_connection(name)
        self._assert_not_in_os_store(account)

    # ── MT-CRED-18 ───────────────────────────────────────────────────────────
    def test_backup_restore_imports_credentials_into_the_os_store(self):
        """MT-CRED-18 (successful swap).

        A backup with one saved password is restored, after its connection and
        OS-store item were deleted, with Restore and restart. After the startup
        swap the connection is back, the OS store holds the backup's password
        again, and no ``termiHub-backup-restore`` seal key is left.
        """
        target, name, account = self._prepare_backup()
        if self.find_connection(name) is not None:
            self._delete_connection(name)
        self._assert_not_in_os_store(account)
        seal_before = self.os_store.accounts(SEAL_SERVICE)

        self._restore_with_credentials(target)

        assert not self.warnings_for("backup restore"), self.warnings_for("backup restore")
        self.switch_to_connections_sidebar()
        self.wait(lambda: self.find_connection(name), what=f"the restored {name!r}")
        self._assert_in_os_store(account)
        self._assert_no_new_seal_keys(seal_before)

    def test_failed_restore_swap_leaves_the_os_store_unchanged(self):
        """MT-CRED-18 (failed swap).

        With the connection and its OS-store item deleted, the harness locks
        the restored ``connections.json`` (macOS ``chflags uchg``, Linux
        ``chattr +i``, Windows a held handle) and restores the backup again. The
        restart reports 'Restoring the backup failed. Your previous data was
        kept unchanged.', the connection stays deleted, nothing is imported
        into the OS store and no seal key is left.
        """
        target, name, account = self._prepare_backup()
        if self.find_connection(name) is not None:
            self._delete_connection(name)
        self._assert_not_in_os_store(account)
        seal_before = self.os_store.accounts(SEAL_SERVICE)

        try:
            lock = locked(self.config_dir / _LOCKED_FILE)
            lock.__enter__()
        except LockUnavailable as exc:
            pytest.skip(f"cannot lock {_LOCKED_FILE}: {exc}")
        try:
            self._restore_with_credentials(target)
            warnings = self.wait(
                lambda: self.warnings_for("backup restore"), what="the failed-restore notice"
            )
            assert _UNCHANGED in warnings[0].get("message", ""), warnings
            self.dismiss_recovery_dialog()
            self.switch_to_connections_sidebar()
            assert self.find_connection(name) is None, "the failed restore brought it back"
            self._assert_no_new_seal_keys(seal_before)
            assert not self.os_store.exists(account), "the failed restore imported a secret"
        finally:
            lock.__exit__(None, None, None)
