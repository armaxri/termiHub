"""Credential-store setup helpers (issue #851).

``CredentialStoreUi`` drives the Settings → Security panel to put the app into a
**master-password** credential store and unlock it. This is what makes the
``savePassword`` ("Save credentials") field appear in the connection editor —
it is filtered out whenever the store mode is ``"none"`` (the mode the
system-test app launches in) — which in turn is required to raise the SSH
key-passphrase prompt on the sidebar-connect path.

It composes :class:`~termihub_harness.ui.SettingsUi` (to open the Security
category) and :class:`~termihub_harness.ui.SidebarUi` (to return to the
connection list afterward), so suites mix all three in alongside
:class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..bridge import BridgeError
from .base import HarnessMixin


class CredentialStoreUi(HarnessMixin):
    """Switch the credential store to master-password mode and unlock it."""

    if TYPE_CHECKING:  # borrowed from the mixins suites combine this with
        def open_settings_category(self, category: str) -> None: ...
        def switch_to_connections_sidebar(self) -> None: ...

    def credential_store_unlocked_master_password(self) -> bool:
        """Whether the store is in master-password mode and currently unlocked."""
        try:
            status = self.driver.get_state("credentialStoreStatus")
        except BridgeError:
            return False
        return isinstance(status, dict) and (
            status.get("mode") == "master_password" and status.get("status") == "unlocked"
        )

    def setup_master_password_store(self, password: str) -> None:
        """Switch to a master-password store, set ``password``, and unlock it.

        No-op if the store is already an unlocked master-password store. Drives the
        Settings → Security panel exactly as a user would: pick the master-password
        radio option, fill the setup dialog, confirm, then wait for the store status
        to flip to unlocked master-password mode before returning to the sidebar.
        """
        if self.credential_store_unlocked_master_password():
            return
        self.open_settings_category("security")
        self.wait(
            lambda: self.driver.exists("storage-mode-master-password"),
            what="the credential storage-mode options",
        )
        self.driver.click("storage-mode-master-password")
        self.wait(
            lambda: self.driver.exists("master-password-input"),
            what="the master-password setup dialog",
        )
        self.driver.type("master-password-input", password)
        self.driver.type("master-password-confirm-input", password)
        self.driver.click("master-password-confirm-btn")
        self.wait(
            self.credential_store_unlocked_master_password,
            what="the credential store to unlock in master-password mode",
        )
        self.switch_to_connections_sidebar()
