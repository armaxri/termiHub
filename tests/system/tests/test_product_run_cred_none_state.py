"""Product run: Settings ▸ Security with no credential storage (#5685).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The UI review of run ``20261113T080834Z``
(``creds.none.default``) found, with no storage chosen:

1. The storage-off lines named the options "Master Password or OS Keychain"
   while the option cards read "OS Keychain" and "Master password".
2. "New shared credential…", "Export vault…" and "Import vault…" rendered as
   normal buttons although none of them can work without a store.

The class runs in its own fresh profile, so the store starts with no storage.
No sshd and no keychain write: the page is only read.
"""

from __future__ import annotations

import pytest

from termihub_harness import CredentialStoreUi, SettingsUi, SidebarUi, SystemTest
from termihub_harness.product_run import ProductRunUi

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

#: The option cards' labels, in chooser order (``CREDENTIAL_STORAGE_CHOICES``).
CARD_LABELS = {
    "storage-mode-os-keychain": "OS Keychain",
    "storage-mode-master-password": "Master password",
}
#: The two storage-off lines that replace the vault-dependent actions.
OFF_LINES = ("shared-credentials-unavailable", "credential-vault-unavailable")
#: Actions that cannot work without a store and must not be offered.
VAULT_ACTIONS = (
    "shared-credentials-create",
    "credential-vault-export-btn",
    "credential-vault-import-btn",
)


class TestProductRunCredentialNoneState(
    ProductRunUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    phase = "Security with no storage"
    request_timeout = 90.0

    def test_10_security_page_without_storage(self):
        with self.step(
            "security-none.default",
            "With no storage, Security names the options as their cards do and offers no "
            "vault action (#5685)",
            expect="#5685: Settings ▸ Security with 'Don't save passwords' selected; Shared "
            "credentials and Credential vault backup each show one line 'choose OS Keychain "
            "or Master password above …' and no New shared credential / Export / Import button",
        ):
            status = self.wait(self.credential_store_status, what="the credential store status")
            assert status.get("mode") == "none", f"the fresh profile has a store: {status}"
            self.open_settings_category("security")
            self.wait(lambda: self.driver.exists("storage-mode-none"), what="the storage options")
            for test_id, label in CARD_LABELS.items():
                card = self.driver.get_text(test_id).strip()
                assert card.startswith(label), f"{test_id} reads {card!r}, not {label!r}"
            wanted = " or ".join(CARD_LABELS.values())
            for test_id in OFF_LINES:
                self.wait(lambda t=test_id: self.driver.exists(t), what=test_id)
                line = self.driver.get_text(test_id).strip()
                self.evidence(f"{test_id}: {line!r}")
                assert f"choose {wanted} above" in line, f"{test_id} reads {line!r}"
            offered = [t for t in VAULT_ACTIONS if self.driver.exists(t)]
            assert not offered, f"vault actions offered without a store: {offered}"
