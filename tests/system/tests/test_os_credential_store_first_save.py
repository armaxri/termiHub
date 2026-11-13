"""Choose the OS keychain in the first-save chooser, then use and leave it (#5514).

The maintainer's product test found that right after choosing **OS Keychain**
in the first-save chooser, every read of a key that was never stored failed
("Failed to read OS keychain entry for …"), and switching to another store was
refused ("the current store (os_keychain) could not be read"), so the user was
stuck in OS-keychain mode. This was a guided-manual flow; it is now unattended.

One fresh app (fresh profile: storage ``none``, no choice made) against the
throwaway OS credential store of :mod:`termihub_harness.os_store`, under a
per-run keychain namespace (``termiHub-dev-ci-<hex>``):

1. a new SSH connection's **Save credentials** opens the first-save chooser;
   **OS Keychain** → Continue switches the store, the password is saved with
   the connection and lands in the OS store;
2. connecting resolves the saved password (no prompt, a live session);
3. switching to a master password and back to the OS keychain migrates it,
   and it still resolves;
4. switching to ``none`` removes it from the OS store.

No step may log an OS keychain read failure. The leftover-item variant of the
bug (an item an earlier, differently signed build wrote, which this build may
not read) cannot be staged here without an OS access prompt; the Rust
real-keychain tests cover it (``src-tauri/src/commands/
credential_real_keychain_tests.rs``).
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    CredentialStoreUi,
    PasswordPromptUi,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.os_store import credential_account

pytestmark = pytest.mark.integration

_MASTER_PASSWORD = "first-save-master-pw-5514"
#: Log lines that mean the OS keychain store failed a read or a switch.
_KEYCHAIN_FAILURES = (
    "Failed to read OS keychain entry",
    "current store (os_keychain) could not be read",
    "Stored field secret keys of",
)


@pytest.mark.usefixtures("ssh_password_fixtures")
@pytest.mark.native_sshd
class TestOsKeychainFirstSave(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    PasswordPromptUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    """Fresh profile → chooser → OS keychain → save, resolve, switch away."""

    os_credential_store = True

    def reset_before_rerun(self) -> None:
        self.dismiss_modals("credential-storage-chooser", "unlock-dialog-body")
        self.close_all_tabs()

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _status(self) -> dict:
        return self.credential_store_status() or {}

    def _mode(self) -> str:
        return str(self._status().get("mode") or "")

    def _keychain_failures(self) -> list[str]:
        """App log lines reporting an OS keychain read or switch failure."""
        text = self.app.log_path.read_text(encoding="utf-8", errors="replace")
        return [
            line
            for line in text.splitlines()
            if any(f in line for f in _KEYCHAIN_FAILURES)
        ]

    def _assert_no_keychain_failures(self, step: str) -> None:
        failures = self._keychain_failures()
        assert not failures, f"{step}: the OS keychain store failed:\n" + "\n".join(failures)

    def _choose_os_keychain_on_first_save(self, name: str) -> None:
        """Fill a new SSH connection and turn on Save credentials via the chooser."""
        self.fill_ssh_connection_form(
            name,
            host=SSH_HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            auth_method="password",
            password=SSH_PASSWORD,
        )
        self.wait(lambda: self.driver.exists("field-savePassword"), what="Save credentials")
        self.driver.click("field-savePassword")
        self.wait(
            lambda: self.driver.exists("credential-storage-chooser-option-os_keychain"),
            what="the first-save storage chooser",
        )
        self.driver.click("credential-storage-chooser-option-os_keychain")
        self.driver.click("credential-storage-chooser-continue")
        self.wait(lambda: self._mode() == "os_keychain", what="the OS keychain store")
        self.wait(
            lambda: not self.driver.exists("credential-storage-chooser"),
            what="the chooser to close",
        )
        self.wait(
            lambda: self.driver.get_attribute("field-savePassword", "aria-checked") == "true",
            what="Save credentials to turn on once the store is chosen",
        )
        self._click_editor_save(False)

    def _assert_resolves(self, name: str) -> None:
        """Connect: the saved password resolves (no prompt) into a live session."""
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        self.accept_host_key_prompt(timeout=10.0)
        self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")
        self.wait(self.has_terminal, what="a live SSH session")
        assert not self.password_prompt_open(), "the saved password did not resolve"
        self.close_all_tabs()

    def _use_os_keychain(self) -> None:
        """Switch to the OS keychain (migrating) through Settings > Security."""
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
        self.wait(lambda: self._mode() == "os_keychain", what="the OS keychain mode")
        self.switch_to_connections_sidebar()

    # ── The flow ─────────────────────────────────────────────────────────────
    def test_first_save_chooser_os_keychain_save_resolve_and_switch_away(self):
        store = self.os_store
        status = self._status()
        assert status.get("mode") == "none", f"not a fresh profile: {status}"
        assert status.get("storageChosen") is False, f"a storage choice exists: {status}"

        # 1. First save: the chooser picks the OS keychain; the password lands there.
        name = unique_name("first-save-keychain")
        self._choose_os_keychain_on_first_save(name)
        account = credential_account(self.require_stable_connection(name)["id"])
        store.track(account)
        self.wait(
            lambda: store.exists(account),
            what=f"{account!r} in the {store.name} (holds: {sorted(store.accounts())})",
        )
        self._assert_no_keychain_failures("saving into the freshly chosen OS keychain")

        # 2. Reconnect resolves the saved password.
        self._assert_resolves(name)
        self._assert_no_keychain_failures("resolving from the OS keychain")

        # 3. Away to a master password and back.
        self.setup_master_password_store(_MASTER_PASSWORD)
        self._assert_no_keychain_failures("switching from the OS keychain to a master password")
        self._assert_resolves(name)
        self._use_os_keychain()
        self.wait(lambda: store.exists(account), what=f"{account!r} back in the {store.name}")
        self._assert_resolves(name)

        # 4. To none: the password leaves the OS store.
        self.migrate_to_no_store()
        self.wait(lambda: not store.exists(account), what=f"{account!r} gone from {store.name}")
        self._assert_no_keychain_failures("switching from the OS keychain to none")
