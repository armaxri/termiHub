/**
 * The backup dialog's steps and their validation (#5847), kept apart from the
 * dialog so they can be tested on their own.
 */
import type { CredentialStorageMode } from "@/types/credential";
import { MIN_EXPORT_PASSPHRASE_LENGTH } from "@/utils/passphraseStrength";

/** Lower-case a label's first letter for mid-sentence use, keeping acronyms ("SSH …"). */
export function midSentence(label: string): string {
  if (label.length > 1 && label[1] === label[1].toUpperCase() && /[A-Z]/.test(label[1])) {
    return label;
  }
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Join items as "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface ExportForm {
  mode: CredentialStorageMode;
  selected: ReadonlySet<string>;
  includeCredentials: boolean;
  encrypt: boolean;
  masterPassword: string;
  passphrase: string;
  confirm: string;
}

/**
 * The steps of the backup dialog (#5847). Each one asks for at most one
 * secret: the backup passphrase on its own, and the master password only in a
 * last step when the backup includes credentials from the master-password vault.
 */
export type BackupExportStep = "choose" | "passphrase" | "masterPassword";

/** Short names of the steps, shown as "Step 2 of 3 · Backup passphrase". */
export const BACKUP_EXPORT_STEP_NAMES: Record<BackupExportStep, string> = {
  choose: "What to back up",
  passphrase: "Backup passphrase",
  masterPassword: "Master password",
};

/** The steps a backup goes through; the master password step only when it is needed. */
export function backupExportSteps(needsMasterPassword: boolean): BackupExportStep[] {
  return needsMasterPassword
    ? ["choose", "passphrase", "masterPassword"]
    : ["choose", "passphrase"];
}

/** Step 1: something must be chosen. */
export function validateChooseStep(form: ExportForm): string | null {
  if (form.selected.size === 0 && !form.includeCredentials) {
    return "Choose at least one thing to back up.";
  }
  return null;
}

/** Step 2: the backup passphrase, unless the file is saved without one. */
export function validatePassphraseStep(form: ExportForm): string | null {
  if (!form.encrypt && !form.includeCredentials) return null;
  if ([...form.passphrase].length < MIN_EXPORT_PASSPHRASE_LENGTH) {
    return `The passphrase must be at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters.`;
  }
  if (form.passphrase !== form.confirm) return "The passphrases do not match.";
  return null;
}

/** Step 3: the master password, only when credentials come from the master-password vault. */
export function validateMasterPasswordStep(form: ExportForm): string | null {
  if (!form.includeCredentials || form.mode !== "master_password") return null;
  if (!form.masterPassword) return "Enter your master password to include your credentials.";
  if (form.passphrase === form.masterPassword) {
    return "The backup passphrase must be different from your master password.";
  }
  return null;
}

/** Client-side validation of the whole form, mirroring the backend rules; an error or null. */
export function validateBackupExport(form: ExportForm): string | null {
  return (
    validateChooseStep(form) ?? validatePassphraseStep(form) ?? validateMasterPasswordStep(form)
  );
}

/**
 * Why the backup cannot be saved without a passphrase, or null when it can:
 * credentials and trust decisions are only ever written locked.
 */
export function plainBackupBlockedReason(lockedOnly: readonly string[]): string | null {
  if (lockedOnly.length === 0) return null;
  return `Not possible while the backup includes ${joinList(lockedOnly.map(midSentence))}.`;
}

/** "3 other kinds have nothing saved yet." — the empty categories as one line (#5847). */
export function emptySectionsLine(count: number): string {
  return count === 1
    ? "1 other kind has nothing saved yet."
    : `${count} other kinds have nothing saved yet.`;
}
