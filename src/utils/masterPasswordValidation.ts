/** Minimum length of a new master password. */
export const MIN_MASTER_PASSWORD_LENGTH = 8;

/** Inline error when the confirmation differs from the new master password. */
export const MASTER_PASSWORD_MISMATCH_TEXT = "Passwords do not match.";

/**
 * The live requirements hint under a new master password (#5552): what is
 * asked for before anything is typed, how far off the minimum a short one is,
 * and that a long one meets it.
 */
export function masterPasswordRequirementHint(password: string): {
  text: string;
  met: boolean;
} {
  const min = MIN_MASTER_PASSWORD_LENGTH;
  if (!password) {
    return { text: `Use at least ${min} characters. A longer passphrase is stronger.`, met: false };
  }
  const missing = min - password.length;
  if (missing > 0) {
    return {
      text: `${missing} more character${missing === 1 ? "" : "s"} needed (at least ${min}).`,
      met: false,
    };
  }
  return {
    text: `Meets the ${min}-character minimum. A longer passphrase is stronger.`,
    met: true,
  };
}

/**
 * Whether to show the mismatch error under the confirmation while typing: only
 * once the confirmation is no longer a prefix of the password, so it does not
 * flash on every keystroke of a correct confirmation.
 */
export function showMasterPasswordMismatch(password: string, confirm: string): boolean {
  return confirm.length > 0 && !password.startsWith(confirm);
}

/**
 * Validate a new master password and its confirmation, returning the inline
 * error to show, or `null` when it is acceptable. Shared by the Settings ▸
 * Security setup and the first-use storage chooser (#5187).
 */
export function validateNewMasterPassword(password: string, confirm: string): string | null {
  if (!password) return "Password is required.";
  if (password !== confirm) return MASTER_PASSWORD_MISMATCH_TEXT;
  if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
