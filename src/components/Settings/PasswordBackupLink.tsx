import { DatabaseBackup } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { CredentialStorageMode } from "@/types/credential";
import { Button } from "@/components/ui";
import { credentialStorageOffText } from "@/utils/credentialStorageCopy";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

import { ICON_SIZE } from "@/components/ui/iconSize";
/**
 * Where the saved passwords are, in the words of the chosen store (#5860, R-052),
 * or `null` while passwords are not saved.
 */
export function passwordBackupText(mode: CredentialStorageMode): string | null {
  const where =
    mode === "os_keychain"
      ? "Passwords saved in the OS Keychain"
      : mode === "master_password"
        ? "Passwords in your master-password vault"
        : null;
  return where === null
    ? null
    : `${where} are backed up with your other data: Back up… in Backup & restore includes them, and Restore… brings them back.`;
}

/**
 * Settings ▸ Security ▸ Back up saved passwords: one backup flow (#5860, R-052).
 * Backup & restore backs the passwords up with everything else; this section says
 * so and goes there, instead of a second, passwords-only export.
 */
export function PasswordBackupLink() {
  const mode: CredentialStorageMode = useAppStore((s) => s.credentialStoreStatus?.mode) ?? "none";
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const text = passwordBackupText(mode);
  const storageOff = text === null;

  return (
    <div
      className="settings-panel__section"
      data-testid="password-backup"
      data-collapsed={storageOff ? "true" : undefined}
    >
      <SettingsSectionHeading>Back up saved passwords</SettingsSectionHeading>
      {/* With passwords not saved the section is its heading and the storage-off line (#5875). */}
      {storageOff ? (
        <p className="settings-panel__description" data-testid="password-backup-unavailable">
          {credentialStorageOffText("back up saved passwords")}
        </p>
      ) : (
        <p className="settings-panel__description" data-testid="password-backup-description">
          {text}
        </p>
      )}
      {!storageOff && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<DatabaseBackup size={ICON_SIZE.sm} />}
            onClick={() => openSettingsTab({ category: "backup" })}
            data-testid="password-backup-open"
          >
            Open backup &amp; restore
          </Button>
        </div>
      )}
    </div>
  );
}
