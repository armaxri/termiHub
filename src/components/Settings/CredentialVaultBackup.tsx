import { useState, useCallback } from "react";
import { Download, Upload } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { CredentialStorageMode, OsAuthInfo } from "@/types/credential";
import { useOsAuthInfo } from "@/hooks/useOsAuthInfo";
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
 * Why export is refused in OS-keychain mode when the OS cannot verify the
 * user. Mirrors the backend `KEYCHAIN_EXPORT_UNAVAILABLE_MESSAGE`; the backend
 * enforces the gate independently (#3433).
 */
export const KEYCHAIN_EXPORT_UNAVAILABLE_REASON =
  "Exporting from the OS keychain requires system authentication (Touch ID / Windows Hello / polkit), which is not available on this computer.";

/** Shown while the OS-verification capability is still being read. */
export const KEYCHAIN_EXPORT_CHECKING_REASON = "Checking system authentication…";

/**
 * Why an OS-keychain export is unavailable, or null when the OS can verify
 * the user. `null` info (not loaded / query failed) fails closed.
 */
export function keychainExportReason(info: OsAuthInfo | null): string | null {
  if (info === null) return KEYCHAIN_EXPORT_CHECKING_REASON;
  if (info.exportReauth.available) return null;
  return [KEYCHAIN_EXPORT_UNAVAILABLE_REASON, info.exportReauth.reason].filter(Boolean).join(" ");
}

/** The note telling the user an OS-keychain export asks the OS to verify them. */
export function keychainExportNote(info: OsAuthInfo): string {
  return `For your protection, termiHub asks you to confirm with ${info.exportReauth.methodLabel} each time you export.`;
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
  const { info: osAuth } = useOsAuthInfo();

  const mode: CredentialStorageMode = credentialStoreStatus?.mode ?? "none";
  const status = credentialStoreStatus?.status;
  const reason = unavailableReason(mode, status);
  // Import into the keychain is fine; export needs OS user verification (#3433).
  const exportReason = reason ?? (mode === "os_keychain" ? keychainExportReason(osAuth) : null);

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
      {!reason && exportReason && (
        <p className="settings-panel__description" data-testid="credential-vault-export-blocked">
          {exportReason}
        </p>
      )}
      <div className="credential-vault__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={14} />}
          disabled={exportReason !== null}
          title={exportReason ?? undefined}
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
      {!exportReason && mode === "os_keychain" && osAuth && (
        <p className="settings-panel__description" data-testid="credential-vault-export-os-auth">
          {keychainExportNote(osAuth)}
        </p>
      )}
      <CredentialVaultExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        mode={mode}
        osAuthLabel={osAuth?.exportReauth.methodLabel}
      />
      <CredentialVaultImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        modeLabel={modeLabel}
      />
    </div>
  );
}
