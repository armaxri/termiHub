import { useState, useCallback } from "react";
import { Download, Upload } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { CredentialStorageMode } from "@/types/credential";
import { Button } from "@/components/ui";
import { CredentialVaultExportDialog } from "./CredentialVaultExportDialog";
import { CredentialVaultImportDialog } from "./CredentialVaultImportDialog";

interface CredentialVaultBackupProps {
  /** Display label of the active store mode, used in the import dialog copy. */
  modeLabel: string;
}

/** Why the vault actions are unavailable in the current store state, or null. */
function unavailableReason(mode: CredentialStorageMode, status: string | undefined): string | null {
  if (mode === "none") {
    return "Credential storage is off — choose Master Password or OS Keychain to back up or restore credentials.";
  }
  if (mode === "master_password" && status === "unavailable") {
    return "Set up a master password first.";
  }
  return null;
}

/**
 * Settings → Security section for exporting and importing the encrypted
 * credential vault (PROD-063). A locked master-password store is unlocked via
 * the shared unlock flow before either dialog opens.
 */
export function CredentialVaultBackup({ modeLabel }: CredentialVaultBackupProps) {
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);
  const requestUnlock = useAppStore((s) => s.requestUnlock);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const mode: CredentialStorageMode = credentialStoreStatus?.mode ?? "none";
  const status = credentialStoreStatus?.status;
  const reason = unavailableReason(mode, status);

  const ensureUnlocked = useCallback(async (): Promise<boolean> => {
    if (mode === "master_password" && status === "locked") {
      return await requestUnlock();
    }
    return true;
  }, [mode, status, requestUnlock]);

  const openExport = useCallback(async () => {
    if (await ensureUnlocked()) setExportOpen(true);
  }, [ensureUnlocked]);

  const openImport = useCallback(async () => {
    if (await ensureUnlocked()) setImportOpen(true);
  }, [ensureUnlocked]);

  return (
    <div className="settings-panel__section" data-testid="credential-vault-backup">
      <h3 className="settings-panel__section-title">Credential Vault Backup</h3>
      <p className="settings-panel__description">
        Export your saved credentials to a passphrase-protected, encrypted file to back them up or
        move them to another machine, and import such a file into your current store.
      </p>
      {reason && (
        <p className="settings-panel__description" data-testid="credential-vault-unavailable">
          {reason}
        </p>
      )}
      <div className="credential-vault__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={14} />}
          disabled={reason !== null}
          onClick={() => void openExport()}
          data-testid="credential-vault-export-btn"
        >
          Export vault…
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={14} />}
          disabled={reason !== null}
          onClick={() => void openImport()}
          data-testid="credential-vault-import-btn"
        >
          Import vault…
        </Button>
      </div>
      <CredentialVaultExportDialog open={exportOpen} onOpenChange={setExportOpen} mode={mode} />
      <CredentialVaultImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        modeLabel={modeLabel}
      />
    </div>
  );
}
