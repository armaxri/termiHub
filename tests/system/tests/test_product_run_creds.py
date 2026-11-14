"""Product run, phase 3a: credential stores and backup / restore (#5537).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Every check is a recorded step with a window capture and an
``expect`` line for the UI review
(:class:`~termihub_harness.product_run.ProductRunUi`).

The secret the steps save is the passphrase of the repo's passphrase fixture
key, used against the run's own native sshd
(:mod:`termihub_harness.product_run.hosts`; key auth only, so a passphrase is
the credential a key-auth host has). The OS keychain is used only under the
run's own service ``termiHub-dev-product-run-<run id>``
(``TERMIHUB_DEV_NAME``); the runner deletes those items at the end. Lookups read
item attributes only, so they raise no keychain prompt. OS security sheets
(keychain Allow, Touch ID, the OS check before exporting keychain secrets) are
human steps: *not tested* in an unattended run.

Steps (in order):

* **none**: the run starts with no store; a connect asks for the passphrase and
  nothing is kept (the next connect asks again).
* **master password**: set up, save on connect, resolve on reconnect, lock,
  a connect on a locked store asks to unlock (a wrong password is refused),
  Touch ID unlock (human, attended only).
* **OS keychain**: switch from the vault with migration (the item lands under
  the run's service), resolve on reconnect and after a restart, remove a
  credential (deleting its connection removes the item), switch to none with
  migration (the item is gone, the next connect asks).
* **backup / restore**: back up connections, settings and the vault's
  credentials, wipe the profile, restore, and check the connections, the theme
  and the saved passphrase come back; a backup of keychain credentials asks the
  OS to verify the user first (human).
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

import pytest

from termihub_harness import (
    SETTINGS_REGION,
    SSH_HOST,
    SSH_KEY_PASSPHRASE,
    SSH_KEY_PASSPHRASE_PATH,
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
from termihub_harness.os_store import credential_account
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.creds_steps import CredsPhaseUi, keychain_has, run_service
from termihub_harness.product_run.ssh_steps import SshPhaseUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only"),
]

MASTER_PASSWORD = "product-run-master-pw"
WRONG_PASSWORD = "not-the-master-pw"
BACKUP_PASSPHRASE = "product-run-backup-pw"
BACKUP_THEME = "solarized-dark"
#: How long a connect may sit before the steps decide whether a prompt came.
PROMPT_WINDOW = 15.0


class _CredsBase(
    ProductRunUi,
    SshPhaseUi,
    CredsPhaseUi,
    CredentialStoreUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    request_timeout = 90.0

    def reset_before_rerun(self) -> None:
        self.dismiss_modals("unlock-dialog-body", "backup-restore-title")
        self.close_all_tabs()

    # ── connection moves ─────────────────────────────────────────────────────
    def new_passphrase_connection(self, label: str, *, save: bool) -> str:
        native = self.need_native()
        name = unique_name(label)
        self.switch_to_connections_sidebar()
        self.create_ssh_connection(
            name, host=SSH_HOST, port=native.target.port, username=native.target.username,
            auth_method="key", key_path=str(SSH_KEY_PASSPHRASE_PATH), save_password=save,
        )
        self.require_stable_connection(name)
        return name

    def account_of(self, name: str) -> str:
        return credential_account(self.require_stable_connection(name)["id"], "key_passphrase")

    def connect_and_grade(self, name: str, marker: str, *, answer: bool) -> bool:
        """Connect ``name``; answer a passphrase prompt when ``answer``. Returns prompted?"""
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        prompted = self._within(self.password_prompt_open, PROMPT_WINDOW)
        if prompted:
            self.shot(label="passphrase-prompt")
            if not answer:
                return True
            self.handle_password_prompt(SSH_KEY_PASSPHRASE)
        self.accept_all_hostkeys(timeout=5.0)
        tab_id = self.tab_id_of(name)
        self.wait_connected(tab_id)
        self.evidence(self.echo_round_trip(tab_id, marker))
        return prompted


class TestProductRunCredentials(_CredsBase):
    phase = "Credentials"

    def test_01_no_store(self):
        with self.step(
            "creds.none.default",
            "A fresh profile has no credential store: no lock indicator, Security shows No storage",
            expect="Settings ▸ Security with 'Credential storage' and the no-storage option selected",
        ):
            self.need_native()
            status = self.wait(self.credential_store_status, what="the credential store status")
            self.evidence(f"store status: {status}")
            assert status.get("mode") == "none", status
            assert not self.credential_indicator_present(), "a lock indicator in none mode"
            self.open_settings_category("security")
            self.wait(lambda: self.driver.exists("storage-mode-none"), what="the storage options")
        name = None
        with self.step(
            "creds.none.prompt",
            "Without a store a passphrase-key connect asks for the passphrase and connects",
            expect="an SSH tab with a shell after the passphrase prompt",
        ):
            name = self.new_passphrase_connection("pr-cred-none", save=False)
            assert self.connect_and_grade(name, "PR_CRED_NONE_OK", answer=True), "no prompt"
        self.close_all_tabs()
        with self.step(
            "creds.none.not-kept",
            "Nothing was kept: the next connect asks again",
            expect="the passphrase prompt over the connections sidebar",
        ):
            self.require("creds.none.prompt")
            assert self.connect_and_grade(name, "-", answer=False), "the passphrase was kept"
            self.cancel_password_prompt()
            assert not self.vault_file().exists(), "a vault file exists without a store"
        self.close_all_tabs()

    def test_02_master_password(self):
        name = None
        with self.step(
            "creds.master.setup",
            "Master password store: set up from Security; the vault file and lock indicator appear",
            expect="the status bar with the unlocked credential-store lock indicator",
        ):
            self.need_native()
            self.setup_master_password_store(MASTER_PASSWORD)
            self.wait(self.credential_indicator_present, what="the lock indicator")
            self.evidence(f"indicator: {self.driver.get_text('credential-store-indicator')!r}")
            assert self.vault_file().exists(), "no credentials.enc after the setup"
        with self.step(
            "creds.master.save",
            "Save on connect: the passphrase is kept in the vault, encrypted",
            expect="an SSH tab with a shell; the passphrase was asked once",
        ):
            self.require("creds.master.setup")
            before = self.vault_file().read_bytes()
            name = self.new_passphrase_connection("pr-cred-master", save=True)
            assert self.connect_and_grade(name, "PR_CRED_MASTER_SAVE", answer=True), "no prompt"
            self.wait(lambda: self.vault_file().read_bytes() != before, what="the vault to change")
            blob = self.vault_file().read_bytes()
            assert SSH_KEY_PASSPHRASE.encode() not in blob, "the passphrase is readable in the vault"
            self.evidence(f"credentials.enc {len(blob)} bytes, passphrase not in plain text")
        self.close_all_tabs()
        with self.step(
            "creds.master.resolve",
            "Reconnect resolves the saved passphrase: no prompt",
            expect="an SSH tab with a shell and no passphrase dialog",
        ):
            self.require("creds.master.save")
            assert not self.connect_and_grade(name, "PR_CRED_MASTER_RESOLVE", answer=False), (
                "the saved passphrase was asked again"
            )
        self.close_all_tabs()
        with self.step(
            "creds.master.lock",
            "Lock from the status bar: the store reports locked",
            expect="the status-bar indicator in its locked state",
        ):
            self.require("creds.master.setup")
            self.lock_credential_store()
            self.evidence(f"indicator: {self.driver.get_text('credential-store-indicator')!r}")
        with self.step(
            "creds.master.wrong-password",
            "A connect on a locked store asks to unlock; a wrong master password is refused",
            expect="the unlock dialog with an error under the password field",
        ):
            self.require("creds.master.lock")
            self.switch_to_connections_sidebar()
            self.connect_connection(name)
            self.wait(lambda: self.driver.exists("unlock-dialog-input"), what="the unlock dialog")
            self.shot(label="unlock-dialog")
            self.driver.type("unlock-dialog-input", WRONG_PASSWORD)
            self.driver.click("unlock-dialog-unlock")
            self.wait(lambda: self.driver.exists("unlock-dialog-error"), what="the unlock error")
            self.evidence(f"error: {self.driver.get_text('unlock-dialog-error')!r}")
            assert self.credential_store_locked(), "a wrong password unlocked the store"
        with self.step(
            "creds.master.unlock",
            "The right master password unlocks; the connect goes on with the saved passphrase",
            expect="an SSH tab with a shell, no passphrase dialog",
        ):
            self.require("creds.master.wrong-password")
            self.handle_unlock_dialog(MASTER_PASSWORD)
            assert not self._within(self.password_prompt_open, 5.0), "the passphrase was asked"
            tab_id = self.tab_id_of(name)
            self.wait_connected(tab_id)
            self.evidence(self.echo_round_trip(tab_id, "PR_CRED_UNLOCKED_OK"))
        self.close_all_tabs()
        self._touch_id()
        type(self)._master_conn = name

    def _touch_id(self) -> None:
        with self.step(
            "creds.master.touch-id",
            "Touch ID unlock: enable it, lock, unlock with a fingerprint (human)",
            expect="Settings ▸ Security with Touch ID unlock switched on",
        ):
            self.require("creds.master.unlock")
            if sys.platform != "darwin":
                pytest.skip("Touch ID is macOS only")
            self.open_settings_category("security")
            if not self._within(lambda: self.driver.exists("biometric-unlock-toggle"), 5.0):
                pytest.skip("Security shows no biometric unlock here (no Touch ID hardware?)")
            # #5752: the protection note shows only while the unlock is on.
            if self.driver.exists("biometric-unlock-protection"):
                note = self.driver.get_text("biometric-unlock-protection")
                self.evidence(f"protection: {note!r}")
            self.human_step(
                "In the test window: Settings ▸ Security ▸ turn on Touch ID unlock, type the master "
                f"password '{MASTER_PASSWORD}', confirm with Touch ID. Then click the lock in the "
                "status bar, click it again and unlock with Touch ID.",
                "the store unlocks with your fingerprint, without typing the master password",
            )
            assert self.credential_store_unlocked_master_password(), "the store is not unlocked"

    def test_03_os_keychain(self):
        name = getattr(type(self), "_master_conn", None)
        account = None
        with self.step(
            "creds.keychain.switch",
            "Vault → OS keychain with migration: the saved passphrase moves to the run's keychain service",
            expect="Settings ▸ Security with OS keychain selected and the migration result",
        ):
            self.require("creds.master.save")
            if sys.platform != "darwin":
                pytest.skip("the keychain lookup is macOS-only")
            if self.credential_store_locked():
                self.unlock_credential_store(MASTER_PASSWORD)
            account = self.account_of(name)
            result = self.switch_store("os_keychain")
            self.evidence(f"migration: {result!r}")
            self.evidence(f"service {run_service()!r}, account {account!r}")
            self.wait(lambda: keychain_has(run_service(), account), what="the keychain item")
            # Keychain mode shows a static "Keychain" item, never the lock toggle.
            indicator = self.driver.get_text("credential-store-indicator").strip()
            self.evidence(f"status bar: {indicator!r}")
            assert indicator == "Keychain", f"status bar shows {indicator!r} in keychain mode"
        self.switch_to_connections_sidebar()
        with self.step(
            "creds.keychain.resolve",
            "Reconnect resolves the passphrase from the keychain: no prompt",
            expect="an SSH tab with a shell and no passphrase dialog",
        ):
            self.require("creds.keychain.switch")
            assert not self.connect_and_grade(name, "PR_CRED_KEYCHAIN_OK", answer=False), (
                "the migrated passphrase was asked again"
            )
        self.close_all_tabs()
        with self.step(
            "creds.keychain.restart",
            "After a restart the store is still the keychain and the passphrase still resolves",
            expect="an SSH tab with a shell after the app restarted",
        ):
            self.require("creds.keychain.resolve")
            self.restart_app()
            self.wait(lambda: self.store_mode() == "os_keychain", what="the keychain store")
            self.close_all_tabs()
            assert not self.connect_and_grade(name, "PR_CRED_RESTART_OK", answer=False), (
                "the passphrase was asked after the restart"
            )
        self.close_all_tabs()
        with self.step(
            "creds.keychain.remove",
            "Removing a credential: deleting its connection removes the keychain item",
            expect="the connections sidebar without the deleted connection",
        ):
            self.require("creds.keychain.switch")
            self.switch_to_connections_sidebar()
            self.connection_context_action(name, self.CTX_DELETE)
            self.wait(lambda: self.find_connection(name) is None, what="the connection deleted")
            self.wait(lambda: not keychain_has(run_service(), account), what="the item removed")
        other = None
        with self.step(
            "creds.keychain.save",
            "Save on connect in keychain mode writes the run's keychain item",
            expect="an SSH tab with a shell after one passphrase prompt",
        ):
            self.require("creds.keychain.switch")
            other = self.new_passphrase_connection("pr-cred-keychain", save=True)
            assert self.connect_and_grade(other, "PR_CRED_KC_SAVE", answer=True), "no prompt"
            self.wait(lambda: keychain_has(run_service(), self.account_of(other)), what="the item")
        self.close_all_tabs()
        with self.step(
            "creds.none.switch",
            "Keychain → no storage with migration: the item is gone and the next connect asks",
            expect="the passphrase prompt after switching to no storage",
        ):
            self.require("creds.keychain.save")
            acct = self.account_of(other)
            result = self.switch_store("none")
            self.evidence(f"migration: {result!r}")
            self.wait(lambda: not keychain_has(run_service(), acct), what="the item removed")
            assert self.connect_and_grade(other, "-", answer=False), "no prompt without a store"
            self.cancel_password_prompt()
        self.close_all_tabs()


class TestProductRunBackup(_CredsBase):
    phase = "Backup & restore"

    def _wipe_profile(self) -> None:
        for child in self.config_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)

    def test_01_backup_wipe_restore(self):
        local = unique_name("pr-bak-local")
        ssh = None
        target = Path(tempfile.mkdtemp(prefix="thub-pr-backup-")) / "termihub-backup.json"
        with self.step(
            "backup.setup",
            "A profile worth backing up: two connections, a theme, a saved passphrase",
            expect="the connections sidebar with a local and an SSH connection, Solarized Dark",
        ):
            self.need_native()
            self.setup_master_password_store(MASTER_PASSWORD)
            self.create_local_connection(local)
            ssh = self.new_passphrase_connection("pr-bak-ssh", save=True)
            assert self.connect_and_grade(ssh, "PR_BAK_SAVED", answer=True), "no prompt"
            self.close_all_tabs()
            self.select_setting("appearance", "appearance-theme-select", BACKUP_THEME,
                                key="theme", expected=BACKUP_THEME)
            self.switch_to_connections_sidebar()
        with self.step(
            "backup.export",
            "Back up everything with credentials: a sealed file, nothing readable in it",
            expect="the Back up dialog with connections, settings and credentials ticked",
        ):
            self.require("backup.setup")
            detail = self.back_up(target, BACKUP_PASSPHRASE, credentials=True,
                                  master_password=MASTER_PASSWORD)
            self.evidence(f"credentials row: {detail!r}")
            self.wait_backup_written(target)
            blob = target.read_text(encoding="utf-8")
            doc = json.loads(blob)
            assert doc.get("encrypted") is True and "contents" not in doc, "not sealed"
            for secret in (local, ssh, SSH_KEY_PASSPHRASE, BACKUP_PASSPHRASE, MASTER_PASSWORD):
                assert secret not in blob, f"{secret!r} is readable in the backup"
            self.evidence(f"{target.name}: {len(blob)} bytes, sealed")
        with self.step(
            "backup.wipe",
            "Wipe the profile: the app starts empty (no connections, default theme, no store)",
            expect="an empty connections sidebar in the default theme",
        ):
            self.require("backup.export")
            self.restart_app(between=self._wipe_profile)
            self.switch_to_connections_sidebar()
            time.sleep(2.0)
            assert self.find_connection(local) is None and self.find_connection(ssh) is None
            theme = self.projection_region_cache(SETTINGS_REGION).get("theme")
            self.evidence(f"theme after wipe: {theme!r}; store: {self.credential_store_status()}")
            assert theme != BACKUP_THEME, "the theme survived the wipe"
        with self.step(
            "backup.restore",
            "Restore with the passphrase: preview, Restore and restart",
            expect="the restore preview listing connections, settings and credentials",
        ):
            self.require("backup.wipe")
            # A wiped profile has no credential store, and credentials only
            # import into one ("Choose Master Password or OS Keychain first"),
            # so set the master-password store up the way a user would first.
            self.setup_master_password_store(MASTER_PASSWORD)
            rows = self.preview_restore(target, BACKUP_PASSPHRASE)
            self.evidence(f"preview: {rows}")
            for section in ("connections", "settings", "credentials"):
                self._toggle(f"backup-restore-include-{section}", True)
            self.shot(label="preview")
            self.driver.click("backup-restore-submit")
            self.adopt_app_self_restart(timeout=120.0)
        with self.step(
            "backup.restored",
            "After the restart the connections and the theme are back",
            expect="the connections sidebar with both connections, in Solarized Dark",
        ):
            self.require("backup.restore")
            self.switch_to_connections_sidebar()
            self.wait(lambda: self.find_connection(local) and self.find_connection(ssh),
                      what="the restored connections")
            self.wait(
                lambda: self.projection_region_cache(SETTINGS_REGION).get("theme") == BACKUP_THEME,
                what="the restored theme",
            )
        with self.step(
            "backup.restored.credentials",
            "The saved passphrase came back: the SSH connection connects without asking it",
            expect="an SSH tab with a shell, no passphrase dialog",
        ):
            self.require("backup.restored")
            status = self.credential_store_status()
            self.evidence(f"store after restore: {status}")
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
            self.connect_connection(ssh)
            if self._within(lambda: self.driver.exists("unlock-dialog-input"), PROMPT_WINDOW):
                self.evidence("the restored vault asks for its master password")
                self.handle_unlock_dialog(MASTER_PASSWORD)
            assert not self._within(self.password_prompt_open, 8.0), (
                "the restored connection asked for the passphrase"
            )
            tab_id = self.tab_id_of(ssh)
            self.wait_connected(tab_id)
            self.evidence(self.echo_round_trip(tab_id, "PR_BAK_RESTORED_OK"))
        self.close_all_tabs()

    def test_02_keychain_export(self):
        with self.step(
            "backup.keychain-export",
            "Backing up OS-keychain credentials asks the OS to verify you first (human)",
            expect="the Back up dialog after the OS check passed",
        ):
            if sys.platform != "darwin":
                pytest.skip("the keychain lookup is macOS-only")
            self.require("backup.restored.credentials")
            self.switch_store("os_keychain")
            self.switch_to_connections_sidebar()
            target = Path(tempfile.mkdtemp(prefix="thub-pr-kc-backup-")) / "kc-backup.json"
            self.back_up(target, BACKUP_PASSPHRASE, credentials=True)
            self.human_step(
                "macOS asks you to confirm with Touch ID or your login password before termiHub "
                "exports keychain passwords. Confirm it.",
                "the backup is written and the dialog closes",
            )
            self.wait_backup_written(target, timeout=60.0)
