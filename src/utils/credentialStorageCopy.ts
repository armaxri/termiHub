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
  "Turning this on asks once where termiHub should keep passwords — the OS Keychain " +
  "is recommended. You can change it later under Settings ▸ Security.";

/**
 * Under a connect-time prompt's save box before any storage choice exists
 * (#5187). The box ticks locally; the chooser opens only after the connect
 * succeeds, never over the prompt (#5867).
 */
export const CREDENTIAL_STORAGE_CHOOSE_HINT =
  "Saved once the connection succeeds. termiHub then asks once where to keep passwords.";

/**
 * The one line a connect-time prompt shows while credential storage is off by
 * choice (#5838), followed by {@link TURN_ON_SAVING_LABEL} as a link. It
 * replaces a disabled box, a sentence and a separate action.
 */
export function storageOffPromptText(secretNoun: "password" | "passphrase"): string {
  return secretNoun === "passphrase" ? "Passphrases aren't saved." : "Passwords aren't saved.";
}

/**
 * Under the editor's password field while credential storage is off or not yet
 * chosen (#5835), after {@link storageOffPromptText}: what a typed password is
 * still for. Followed by {@link TURN_ON_SAVING_LABEL}.
 */
export const TYPED_PASSWORD_USE_TEXT = "This one is used only for Test and this connect.";

/** The link after {@link storageOffPromptText}: opens the storage setting. */
export const TURN_ON_SAVING_LABEL = "Turn on saving…";

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

/**
 * The irreversible fact about a master password, shown as a warning callout
 * above the setup inputs in the chooser and in Settings ▸ Security (#5560).
 */
export const MASTER_PASSWORD_NOT_RECOVERABLE_TEXT =
  "Your master password cannot be recovered if you forget it.";

/** Title of the first-use credential-storage chooser (#5187). */
export const CREDENTIAL_STORAGE_CHOOSER_TITLE = "Where should termiHub keep passwords?";

/**
 * The chooser's dismiss action when ticking a save control opened it (#5825):
 * it names what dismissing does — this secret is not saved and the tick goes
 * back off — instead of a bare "Cancel".
 */
export const CREDENTIAL_STORAGE_DISMISS_SAVE_LABEL = "Don't save this password";

/**
 * The line a save control shows in place, under itself, once the chooser set
 * a store up from it (#5825). Shown inline instead of a toast: the result is
 * visible where the user acted (toast policy #5859).
 */
export function credentialStorageChosenText(mode: CredentialStorageMode): string | null {
  switch (mode) {
    case "os_keychain":
      return "Passwords will be stored in the OS Keychain.";
    case "master_password":
      return "Passwords will be stored in your master-password vault.";
    default:
      return null;
  }
}

/** Where the choice can be changed later — the same setting the chooser writes. */
export const CREDENTIAL_STORAGE_CHANGE_LATER_TEXT =
  "You can change this any time under Settings ▸ Security ▸ Credential storage.";

/**
 * The credential-storage options, OS Keychain first (recommended, pre-selected
 * in the chooser). The single list both the first-use chooser and Settings ▸
 * Security ▸ Credential storage render (#5553), so the user meets the same
 * order, names, descriptions and badge on both surfaces.
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
    label: "Master password",
    description:
      "An encrypted termiHub vault, locked with a master password you set. " +
      "Backup & restore moves it to another computer.",
  },
  {
    mode: "none",
    label: "Don't save passwords",
    description: "You'll be asked for passwords each time you connect.",
  },
];

/**
 * The storing options by their exact option labels ("OS Keychain or Master
 * password"), in chooser order, so text that points at them never drifts from
 * the cards (#5685).
 */
function storingOptionLabels(): string {
  return CREDENTIAL_STORAGE_CHOICES.filter((c) => c.mode !== "none")
    .map((c) => c.label)
    .join(" or ");
}

/**
 * Settings ▸ Security line shown in place of a vault-dependent action while no
 * credential storage is chosen (#5685), e.g. "Passwords aren't saved —
 * choose OS Keychain or Master password above to use shared credentials."
 */
export function credentialStorageOffText(purpose: string): string {
  // In the words of the option the user picked, "Don't save passwords" (#5860, G-011).
  return `Passwords aren't saved — choose ${storingOptionLabels()} above to ${purpose}.`;
}

/**
 * Restore preview line when the backup carries credentials but credential
 * storage is off (#5631): says plainly they will not come back, and how to fix it.
 */
export function credentialRestoreStorageOffText(): string {
  return (
    "Credential storage is off, so credentials won't be restored. " +
    `Set up ${storingOptionLabels()} to restore them.`
  );
}

/**
 * Restore preview, credentials going into a master-password vault (#5824):
 * after the restart the vault is locked, so the first connect asks for it.
 */
export const RESTORED_CREDENTIALS_LOCKED_TEXT =
  "Restored passwords stay locked with your master password: after the restart, enter it on " +
  "the first connect.";

/** Restore dialog notice beside the primary action when credentials are left out (#5631). */
export const CREDENTIALS_NOT_RESTORED_TEXT = "Credentials will not be restored.";

/** Inline action that opens the storage chooser from the restore preview (#5631). */
export const SET_UP_CREDENTIAL_STORAGE_LABEL = "Set up storage…";
