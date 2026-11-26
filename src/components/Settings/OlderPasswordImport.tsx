import { useState, useCallback } from "react";
import { Upload } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { CredentialStorageMode } from "@/types/credential";
import { Button } from "@/components/ui";
import {
  CREDENTIAL_STORAGE_CHOICES,
  credentialRestoreStorageOffText,
} from "@/utils/credentialStorageCopy";
import { CredentialVaultImportDialog } from "./CredentialVaultImportDialog";

/** Why passwords cannot be restored into the current store, or null. */
function unavailableReason(mode: CredentialStorageMode, status: string | undefined): string | null {
  if (mode === "none") return credentialRestoreStorageOffText();
  if (mode === "master_password" && status === "unavailable") {
    return "Set up a master password first.";
  }
  return null;
}

/**
 * Backup & restore ▸ restore passwords from a file an older termiHub exported
 * with Settings ▸ Security ▸ Export vault (PROD-063). Backing up is one flow
 * since #5860 (R-052): passwords go into the backup with everything else; this
 * keeps the older files readable. A locked master-password store is unlocked
 * through the shared unlock flow first.
 */
export function OlderPasswordImport() {
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);
  const requestUnlock = useAppStore((s) => s.requestUnlock);
  const [open, setOpen] = useState(false);

  const mode: CredentialStorageMode = credentialStoreStatus?.mode ?? "none";
  const status = credentialStoreStatus?.status;
  const reason = unavailableReason(mode, status);
  const storeLabel = CREDENTIAL_STORAGE_CHOICES.find((c) => c.mode === mode)?.label ?? mode;

  const openImport = useCallback(async () => {
    if (mode === "master_password" && status === "locked" && !(await requestUnlock())) return;
    setOpen(true);
  }, [mode, status, requestUnlock]);

  return (
    <div className="backup-restore__older" data-testid="older-password-import">
      <p className="settings-panel__description">
        Have a password file from an older termiHub (its Export vault)? Restore the passwords in it
        here.
      </p>
      {reason ? (
        <p className="settings-panel__description" data-testid="older-password-import-unavailable">
          {reason}
        </p>
      ) : (
        <div className="credential-vault__actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<Upload size={14} />}
            onClick={() => void openImport()}
            data-testid="older-password-import-btn"
          >
            Restore passwords from an older export…
          </Button>
        </div>
      )}
      <CredentialVaultImportDialog open={open} onOpenChange={setOpen} modeLabel={storeLabel} />
    </div>
  );
}
