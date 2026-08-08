"""Credential-store setup helpers (issues #851, #857).

``CredentialStoreUi`` drives the credential store the way a user would: it sets up
and unlocks a **master-password** store via the Settings → Security panel, and
locks/unlocks it via the status-bar indicator. The master-password mode is what
makes the ``savePassword`` ("Save credentials") field appear in the connection
editor — it is filtered out whenever the store mode is ``"none"`` (the mode the
system-test app launches in) — which in turn is required to raise the SSH
key-passphrase prompt on the sidebar-connect path.

It composes :class:`~termihub_harness.ui.SettingsUi` (to open the Security
category) and :class:`~termihub_harness.ui.SidebarUi` (to return to the
connection list afterward), so suites mix all three in alongside
:class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import Any, Optional, TYPE_CHECKING

from ..bridge import BridgeError
from .base import HarnessMixin
from .settings import SETTINGS_REGION

#: Status-bar indicator that toggles lock state (lock when unlocked, open the
#: unlock dialog when locked) — only rendered in master-password mode.
INDICATOR = "credential-store-indicator"


class CredentialStoreUi(HarnessMixin):
    """Set up, lock, and unlock the master-password credential store."""

    if TYPE_CHECKING:  # borrowed from the mixins suites combine this with
        def open_settings_category(self, category: str) -> None: ...
        def switch_to_connections_sidebar(self) -> None: ...

    # -- status ------------------------------------------------------------------
    def credential_store_status(self) -> Optional[dict[str, Any]]:
        """The live ``credentialStoreStatus`` (``{mode, status}``) or ``None``."""
        try:
            status = self.driver.get_state("credentialStoreStatus")
        except BridgeError:
            return None
        return status if isinstance(status, dict) else None

    def _is_master_password(self, want_status: str) -> bool:
        status = self.credential_store_status()
        return bool(
            status
            and status.get("mode") == "master_password"
            and status.get("status") == want_status
        )

    def credential_store_unlocked_master_password(self) -> bool:
        """Whether the store is in master-password mode and currently unlocked."""
        return self._is_master_password("unlocked")

    def credential_store_locked(self) -> bool:
        """Whether the store is in master-password mode and currently locked."""
        return self._is_master_password("locked")

    # -- setup / lock / unlock ---------------------------------------------------
    def setup_master_password_store(self, password: str) -> None:
        """Ensure the store is an unlocked master-password store with ``password``.

        No-op if already unlocked. If the store is in master-password mode but
        *locked* (e.g. after an app restart — clicking the already-active radio
        would be a no-op), it is unlocked via the indicator instead. Otherwise it
        drives the Settings → Security panel exactly as a user would: pick the
        master-password radio, fill the setup dialog, confirm, then wait for the
        store to report unlocked master-password mode before returning to the
        sidebar.
        """
        if self.credential_store_unlocked_master_password():
            return
        if self.credential_store_locked():
            self.unlock_credential_store(password)
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

    def credential_indicator_present(self) -> bool:
        """Whether the status-bar credential indicator is in the DOM.

        Only master-password mode renders it; ``none``/keychain modes hide it.
        """
        return self.driver.exists(INDICATOR)

    def _click_indicator(self) -> None:
        """Click the status-bar lock indicator (lock when unlocked, open dialog when locked)."""
        self.wait(lambda: self.driver.exists(INDICATOR), what="the credential indicator")
        self.driver.click(INDICATOR)

    def open_unlock_dialog(self) -> None:
        """Open the unlock dialog from a locked store, without unlocking it.

        Clicks the locked status-bar indicator and waits for the dialog's input,
        so a test can drive the dialog directly (e.g. a wrong-password or Skip
        flow). Use :meth:`unlock_credential_store` when you just want it unlocked.
        """
        self._click_indicator()
        self.wait(
            lambda: self.driver.exists("unlock-dialog-input"), what="the unlock dialog"
        )

    def lock_credential_store(self) -> None:
        """Lock an unlocked master-password store via the status-bar indicator."""
        self._click_indicator()
        self.wait(self.credential_store_locked, what="the credential store to lock")

    def handle_unlock_dialog(self, password: str) -> None:
        """Answer an already-open unlock dialog (e.g. raised by a connect attempt)."""
        self.wait(
            lambda: self.driver.exists("unlock-dialog-input"), what="the unlock dialog"
        )
        self.driver.type("unlock-dialog-input", password)
        self.driver.click("unlock-dialog-unlock")
        self.wait(
            self.credential_store_unlocked_master_password,
            what="the credential store to unlock",
        )

    def unlock_credential_store(self, password: str) -> None:
        """Open the unlock dialog via the indicator and unlock with ``password``."""
        self._click_indicator()
        self.handle_unlock_dialog(password)

    # -- change password / auto-lock / migration ---------------------------------
    def change_master_password(self, current: str, new: str) -> None:
        """Change the master password from ``current`` to ``new`` via Settings.

        The store must be in unlocked master-password mode. Drives the Security
        panel's change-password dialog and returns to the connection sidebar; the
        store stays unlocked afterward (only the on-disk vault is re-encrypted).
        """
        self.open_settings_category("security")
        self.wait(
            lambda: self.driver.exists("change-master-password-btn"),
            what="the change-master-password button",
        )
        self.driver.click("change-master-password-btn")
        self.wait(
            lambda: self.driver.exists("change-master-password-current"),
            what="the change-password dialog",
        )
        self.driver.type("change-master-password-current", current)
        self.driver.type("change-master-password-new", new)
        self.driver.type("change-master-password-confirm", new)
        self.driver.click("change-master-password-confirm-btn")
        self.wait(
            lambda: not self.driver.exists("change-password-dialog"),
            what="the change-password dialog to close",
        )
        self.switch_to_connections_sidebar()

    def set_auto_lock_timeout(self, minutes: int) -> None:
        """Select an auto-lock timeout (minutes) in the Security panel.

        Verifies the setting round-trips into the store. The timeout options start
        at 5 minutes, so a test cannot wait for the lock to actually fire — that is
        covered by a manual test; this asserts the wiring, not the timer.
        """
        self.open_settings_category("security")
        self.wait(
            lambda: self.driver.exists("auto-lock-timeout"), what="the auto-lock select"
        )
        self.driver.select("auto-lock-timeout", str(minutes))
        self.wait(
            # Region-authoritative (#2227): the persisted value lives in the
            # projected `settings` document, not an appStore `settings` slice (#2479).
            lambda: self.projection_region_cache(SETTINGS_REGION).get("credentialAutoLockMinutes")
            == minutes,
            what=f"the auto-lock timeout to persist as {minutes}",
        )
        self.switch_to_connections_sidebar()

    def migrate_to_no_store(self) -> None:
        """Switch a master-password store back to ``"none"`` (migrating credentials).

        Drives the Security panel's no-storage radio + confirm dialog and waits for
        the migration result and the mode flip. Ends on the connection sidebar.
        """
        self.open_settings_category("security")
        self.wait(
            lambda: self.driver.exists("storage-mode-none"),
            what="the credential storage-mode options",
        )
        self.driver.click("storage-mode-none")
        self.wait(
            lambda: self.driver.exists("confirm-switch-confirm-btn"),
            what="the switch-to-no-storage confirm dialog",
        )
        self.driver.click("confirm-switch-confirm-btn")
        # The panel reports a migration result, and the store mode flips to none.
        self.wait(
            lambda: self.driver.exists("migration-result"), what="the migration result"
        )
        self.wait(
            lambda: (self.credential_store_status() or {}).get("mode") == "none",
            what="the credential store to switch to none",
        )
        self.switch_to_connections_sidebar()
