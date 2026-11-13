"""Product run: restoring a backup while credential storage is off (#5631).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The UI review of run ``20261113T080834Z``
(``backup.restore``) found, with no credential storage:

1. Credentials were disabled with "Choose Master Password or OS Keychain first"
   and no way forward: the user had to cancel the restore to set up storage,
   and nothing said whether continuing would lose the credentials.
2. "Restore and restart" was a green outline (the Preview button's lingering
   success state) instead of the filled primary, and the whole modal had a
   focus ring around it.
3. The replace warning read "your current Settings" mid-sentence.

The class runs in its own fresh profile. It sets a master-password store up,
backs up connections, settings and the (empty) vault, turns storage off and
previews the restore: the dialog must say "Credentials will not be restored."
beside the actions, explain why in the Credentials row with the option cards'
names, and offer "Set up storage…" — which opens the storage chooser and, once
a master password is set, re-enables Credentials. No sshd and no keychain
write: only the master-password vault is used.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from termihub_harness import CredentialStoreUi, SettingsUi, SidebarUi, SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.creds_steps import CredsPhaseUi

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

MASTER_PASSWORD = "product-run-restore-off-pw"
BACKUP_PASSPHRASE = "product-run-restore-off-backup"
#: The notice beside the restore actions while credentials are left out.
SKIPPED_NOTICE = "Credentials will not be restored."
#: The option cards' labels, as the Credentials row must name them.
OPTION_NAMES = "OS Keychain or Master password"


class TestProductRunRestoreStorageOff(
    ProductRunUi,
    CredsPhaseUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    phase = "Restore with no storage"
    request_timeout = 90.0

    def reset_before_rerun(self) -> None:
        self.dismiss_modals("credential-storage-chooser-body", "backup-restore-title")

    def _class_names(self, test_id: str) -> str:
        return self.driver.get_attribute(test_id, "class") or ""

    def test_10_restore_with_storage_off(self):
        target = Path(tempfile.mkdtemp(prefix="thub-pr-restore-off-")) / "termihub-backup.json"
        with self.step(
            "backup.restore.storage-off",
            "Restoring with storage off says the credentials won't be restored, offers "
            "Set up storage…, and Restore is a filled button (#5631)",
            expect="#5631: the restore preview with Credentials unticked, its line 'Credential "
            "storage is off, so credentials won't be restored. Set up OS Keychain or Master "
            "password …', a 'Set up storage…' button, 'Credentials will not be restored.' left "
            "of Cancel, and a filled red 'Restore and restart' (Settings is replaced); no "
            "focus ring around the dialog; the warning reads 'your current settings'",
        ):
            self.setup_master_password_store(MASTER_PASSWORD)
            self.back_up(target, BACKUP_PASSPHRASE, credentials=True,
                         master_password=MASTER_PASSWORD)
            self.wait_backup_written(target)
            self.switch_store("none", shot_label=None)
            rows = self.preview_restore(target, BACKUP_PASSPHRASE)
            self.evidence(f"preview: {rows}")

            problems = []
            detail = rows.get("backup-restore-credentials-detail", "")
            if "won't be restored" not in detail or OPTION_NAMES not in detail:
                problems.append(f"credentials row reads {detail!r}")
            if self.driver.get_attribute("backup-restore-include-credentials", "disabled") is None:
                problems.append("the Credentials checkbox is enabled with storage off")
            if not self.driver.exists("backup-restore-credentials-skipped"):
                problems.append("no 'Credentials will not be restored.' notice")
            else:
                notice = self.driver.get_text("backup-restore-credentials-skipped").strip()
                if notice != SKIPPED_NOTICE:
                    problems.append(f"notice reads {notice!r}")
            if not self.driver.exists("backup-restore-setup-storage"):
                problems.append("no 'Set up storage…' action")
            submit = self._class_names("backup-restore-submit")
            self.evidence(f"submit classes: {submit!r}")
            if "ui-btn--success" in submit:
                problems.append("Restore carries the Preview button's success state")
            if "ui-btn--primary" not in submit and "ui-btn--danger" not in submit:
                problems.append(f"Restore is not a filled button: {submit!r}")
            if self.driver.exists("backup-restore-replace-warning"):
                warning = self.driver.get_text("backup-restore-replace-warning")
                if "current Settings" in warning:
                    problems.append(f"replace warning not in sentence case: {warning!r}")
            self.shot(label="preview")
            assert not problems, "; ".join(problems)

        with self.step(
            "backup.restore.storage-off.setup",
            "Set up storage… opens the storage chooser; after a master password is set, "
            "Credentials can be restored (#5631)",
            expect="#5631: the restore preview again, Credentials ticked with its counts, no "
            "'Credentials will not be restored.' notice",
        ):
            self.require("backup.restore.storage-off")
            self.driver.click("backup-restore-setup-storage")
            self.wait(
                lambda: self.driver.exists("credential-storage-chooser-body"),
                what="the storage chooser",
            )
            self.shot(label="chooser")
            self.driver.click("credential-storage-chooser-option-master_password")
            self.driver.click("credential-storage-chooser-continue")
            self.wait(
                lambda: self.driver.exists("credential-storage-chooser-master-password-input"),
                what="the master-password step",
            )
            self.driver.type("credential-storage-chooser-master-password-input", MASTER_PASSWORD)
            self.driver.type(
                "credential-storage-chooser-master-password-confirm-input", MASTER_PASSWORD
            )
            self.driver.click("credential-storage-chooser-continue")
            self.wait(
                lambda: not self.driver.exists("credential-storage-chooser-body"),
                what="the chooser to close",
            )
            self.wait(
                lambda: self.driver.get_attribute(
                    "backup-restore-include-credentials", "aria-checked"
                ) == "true",
                what="Credentials to be restorable",
            )
            assert not self.driver.exists("backup-restore-credentials-skipped"), (
                "the 'not restored' notice stayed after storage was set up"
            )
            assert not self.driver.exists("backup-restore-setup-storage")
            self.evidence(
                "credentials: " + self.driver.get_text("backup-restore-credentials-detail").strip()
            )
            self.shot(label="credentials-enabled")
            self.driver.click("modal-close")
