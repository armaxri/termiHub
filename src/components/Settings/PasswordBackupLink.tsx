import { DatabaseBackup } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { CredentialStorageMode } from "@/types/credential";
import { Button } from "@/components/ui";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

/** Where the saved passwords are, in the words of the chosen store (#5860, R-052). */
export function passwordBackupText(mode: CredentialStorageMode): string {
  switch (mode) {
    case "os_keychain":
      return "Passwords saved in the OS Keychain are backed up with your other data: Back up… in Backup & restore includes them, and Restore… brings them back.";
    case "master_password":
      return "Passwords in your master-password vault are backed up with your other data: Back up… in Backup & restore includes them, and Restore… brings them back.";
    default:
      return "Passwords are not saved, so there are none to back up.";
  }
}

/**
 * Settings ▸ Security ▸ Back up saved passwords: one backup flow (#5860, R-052).
 * Backup & restore backs the passwords up with everything else; this section says
 * so and goes there, instead of a second, passwords-only export.
 */
export function PasswordBackupLink() {
  const mode: CredentialStorageMode = useAppStore((s) => s.credentialStoreStatus?.mode) ?? "none";
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const storageOff = mode === "none";

  return (
    <div
      className="settings-panel__section"
      data-testid="password-backup"
      data-collapsed={storageOff ? "true" : undefined}
    >
      <SettingsSectionHeading>Back up saved passwords</SettingsSectionHeading>
      <p className="settings-panel__description" data-testid="password-backup-text">
        {passwordBackupText(mode)}
      </p>
      {!storageOff && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<DatabaseBackup size={14} />}
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
