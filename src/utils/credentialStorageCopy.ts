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

/**
 * Help paragraph for the editor's save toggle before any storage choice exists
 * (#5187): turning it on asks where to keep passwords.
 */
export const CREDENTIAL_STORAGE_CHOOSE_TEXT =
  "Turning this on asks once where termiHub should keep passwords — the OS keychain " +
  "is recommended. You can change it later under Settings ▸ Security.";

/** Under a live save box before any storage choice exists (#5187). */
export const CREDENTIAL_STORAGE_CHOOSE_HINT =
  "Tick to choose where termiHub keeps passwords. Saved once the connection succeeds.";

/** Label of the action that leads a user in None mode to the storage setting. */
export const ENABLE_CREDENTIAL_STORAGE_LABEL = "Enable credential storage…";

const MODE_PARAGRAPH: Record<CredentialStorageMode, string> = {
  none: CREDENTIAL_STORAGE_OFF_TEXT,
  os_keychain:
    "Credentials are stored in your operating system's keychain (macOS Keychain, " +
    "Windows Credential Manager, or Linux Secret Service). The OS manages access, " +
    "so there is nothing extra to unlock.",
  master_password:
    "The vault is protected by your master password using AES-256-GCM encryption. " +
    "You will be asked for the master password once per session to unlock the vault.",
};

/**
 * The paragraph describing where saved credentials go for `mode`, or `null`
 * while the mode is still unknown (store status not loaded yet). Before any
 * storage choice exists (`needsChoice`, #5187) it says the first save asks.
 */
export function credentialStorageParagraph(
  mode: CredentialStorageMode | undefined,
  needsChoice = false
): string | null {
  if (needsChoice) return CREDENTIAL_STORAGE_CHOOSE_TEXT;
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
  mode: CredentialStorageMode | undefined,
  needsChoice = false
): string | undefined {
  const base = helpText ?? undefined;
  const paragraph = credentialStorageParagraph(mode, needsChoice);
  if (!paragraph) return base;
  if (!base) return paragraph;
  return mode === "none" ? `${paragraph}\n\n${base}` : `${base}\n\n${paragraph}`;
}

/** Apply {@link modeAwareSaveHelpText} to a `savePassword` field; other fields pass through. */
export function withModeAwareSaveHelp(
  field: SettingsField,
  mode: CredentialStorageMode | undefined,
  needsChoice = false
): SettingsField {
  if (field.key !== SAVE_PASSWORD_KEY) return field;
  const helpText = modeAwareSaveHelpText(field.helpText, mode, needsChoice);
  return helpText === (field.helpText ?? undefined) ? field : { ...field, helpText };
}

/** One option of the first-use credential-storage chooser (#5187). */
export interface CredentialStorageChoiceCopy {
  mode: CredentialStorageMode;
  label: string;
  badge?: string;
  description: string;
}

/** Title of the first-use credential-storage chooser (#5187). */
export const CREDENTIAL_STORAGE_CHOOSER_TITLE = "Where should termiHub keep passwords?";

/** Where the choice can be changed later — the same setting the chooser writes. */
export const CREDENTIAL_STORAGE_CHANGE_LATER_TEXT =
  "You can change this any time under Settings ▸ Security ▸ Credential Storage.";

/**
 * The chooser's options, OS Keychain first (pre-selected). Labels match the
 * Settings ▸ Security options, so the user finds the same choice there.
 */
export const CREDENTIAL_STORAGE_CHOICES: CredentialStorageChoiceCopy[] = [
  {
    mode: "os_keychain",
    label: "OS Keychain",
    badge: "Recommended",
    description:
      "Managed by your operating system and unlocked with your login. " +
      "Nothing extra to remember.",
  },
  {
    mode: "master_password",
    label: "Master Password",
    description:
      "An encrypted termiHub vault, locked with a master password you set. " +
      "Portable — you can export it to another machine.",
  },
  {
    mode: "none",
    label: "Don't save passwords",
    description: "You'll be asked for passwords each time you connect.",
  },
];
