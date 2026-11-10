/**
 * Storage-mode-aware copy for the "Save credentials" affordances (#5186).
 *
 * The core schema's `savePassword` help text is mode-neutral: it explains what
 * is saved, never where. The frontend knows the active credential storage mode
 * and adds the matching paragraph at render time, so no copy mentions a master
 * password unless the mode actually is Master Password.
 */

import type { CredentialStorageMode } from "@/types/generated/CredentialStorageMode";
import type { SettingsField } from "@/types/schema";

/** Settings key every connection type uses for "save my secret" (core `SAVE_PASSWORD_KEY`). */
export const SAVE_PASSWORD_KEY = "savePassword";

/** Shown wherever saving is offered while credential storage is off. */
export const CREDENTIAL_STORAGE_OFF_TEXT =
  "Credential storage is off — enable it under Settings ▸ Security to save this.";

/** Label of the action that leads a user in None mode to the storage setting. */
export const ENABLE_CREDENTIAL_STORAGE_LABEL = "Enable credential storage…";

const MODE_PARAGRAPH: Record<CredentialStorageMode, string> = {
  none: CREDENTIAL_STORAGE_OFF_TEXT,
  os_keychain:
    "Credentials are stored in your operating system's keychain (macOS Keychain, " +
    "Windows Credential Manager, or Linux Secret Service). The OS manages access — " +
    "no master password needed.",
  master_password:
    "The vault is protected by your master password using AES-256-GCM encryption. " +
    "You will be asked for the master password once per session to unlock the vault.",
};

/**
 * The paragraph describing where saved credentials go for `mode`, or `null`
 * while the mode is still unknown (store status not loaded yet).
 */
export function credentialStorageParagraph(mode: CredentialStorageMode | undefined): string | null {
  return mode ? MODE_PARAGRAPH[mode] : null;
}

/**
 * Combine a field's mode-neutral help text with the storage-mode paragraph.
 * In None mode the "storage is off" notice leads, since it is what the user
 * needs first; otherwise the mode paragraph follows the field's own text.
 * Returns the help text unchanged when the mode is unknown.
 */
export function modeAwareSaveHelpText(
  helpText: string | null | undefined,
  mode: CredentialStorageMode | undefined
): string | undefined {
  const base = helpText ?? undefined;
  const paragraph = credentialStorageParagraph(mode);
  if (!paragraph) return base;
  if (!base) return paragraph;
  return mode === "none" ? `${paragraph}\n\n${base}` : `${base}\n\n${paragraph}`;
}

/** Apply {@link modeAwareSaveHelpText} to a `savePassword` field; other fields pass through. */
export function withModeAwareSaveHelp(
  field: SettingsField,
  mode: CredentialStorageMode | undefined
): SettingsField {
  if (field.key !== SAVE_PASSWORD_KEY) return field;
  const helpText = modeAwareSaveHelpText(field.helpText, mode);
  return helpText === (field.helpText ?? undefined) ? field : { ...field, helpText };
}
