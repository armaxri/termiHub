/** Minimum length of a new master password. */
export const MIN_MASTER_PASSWORD_LENGTH = 8;

/**
 * Validate a new master password and its confirmation, returning the inline
 * error to show, or `null` when it is acceptable. Shared by the Settings ▸
 * Security setup and the first-use storage chooser (#5187).
 */
export function validateNewMasterPassword(password: string, confirm: string): string | null {
  if (!password) return "Password is required.";
  if (password !== confirm) return "Passwords do not match.";
  if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
