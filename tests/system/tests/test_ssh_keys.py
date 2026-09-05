"""SSH key-authentication system tests (ported from infrastructure/ssh-keys.test.js).

Exercises the key-auth UI flow against the key-only ssh-keys container (2203):
plain ed25519, a passphrase-protected key, and a PEM-format RSA key.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    CredentialStoreUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SSH_KEYS_PORT,
    SSH_KEY_PASSPHRASE,
    SSH_KEY_PASSPHRASE_PATH,
    SSH_KEY_PATH,
    SSH_USERNAME,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"
KEYS_DIR = SSH_KEY_PATH.parent
MASTER_PASSWORD = "system-test-master-pw"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshKeyAuthUi(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    PasswordPromptUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    def test_editor_saves_a_key_auth_connection(self):
        # The "key auth via UI" smoke check: the editor builds + persists a
        # key-auth SSH connection (the original WebdriverIO test only verified
        # the editor did not crash).
        name = unique_name("ssh-key-ui")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=False,
        )
        # connections is region-authoritative since the Phase-5 reducer removal:
        # read the connections projection region (ConnectionsView twin,
        # {"folders": [...], "connections": [...]}) via find_connection instead of
        # the removed get_state("connections") slice (#2626).
        self.wait(lambda: self.find_connection(name), what="connection to save")

    def test_ed25519_connects_without_prompt(self):
        self._connect_with_key("ssh-ed25519", SSH_KEY_PATH)

    def test_pem_rsa_connects_without_prompt(self):
        self._connect_with_key("ssh-pem-rsa", KEYS_DIR / "rsa_2048")

    def test_passphrase_protected_key_prompts_then_connects(self):
        # The key-passphrase prompt is only raised on the sidebar-connect path
        # (ConnectionList.requestPassword), reachable via the bridge's doubleClick
        # verb (#830), and only when the "Save credentials" (savePassword) field is
        # on — which requires a non-"none" credential store (#851). So: set up a
        # master-password store, save a key-auth connection with save_password=True,
        # double-click to connect, answer the passphrase prompt, and land in a shell.
        key_path = SSH_KEY_PASSPHRASE_PATH
        if not key_path.exists():
            pytest.skip(f"SSH key fixture missing: {key_path}")
        self.setup_master_password_store(MASTER_PASSWORD)
        name = unique_name("ssh-passphrase")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(key_path),
            save_password=True,
            connect=False,
        )
        self.require_connection(name)
        self.connect_connection(name)
        self.handle_password_prompt(SSH_KEY_PASSPHRASE)
        tab = self.wait(lambda: self.find_tab(name), what="the SSH passphrase-key tab")
        assert tab is not None
        self.wait(self.has_terminal, what="the SSH terminal session")

    def _connect_with_key(self, prefix: str, key_path) -> None:
        if not key_path.exists():
            pytest.skip(f"SSH key fixture missing: {key_path}")
        name = unique_name(prefix)
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(key_path),
            connect=True,
        )
        tab = self.wait(lambda: self.find_tab(name), what="the SSH key tab")
        assert tab is not None
        assert not self.password_prompt_open()
        self.wait(self.has_terminal, what="the SSH terminal session")
