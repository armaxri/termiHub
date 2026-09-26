/** Minimum export-passphrase length, mirroring the backend `MIN_EXPORT_PASSPHRASE_LEN`. */
export const MIN_EXPORT_PASSPHRASE_LENGTH = 12;

/** Coarse strength rating for a passphrase. */
export type PassphraseStrength = "tooShort" | "weak" | "fair" | "strong";

/** A strength rating plus a short, actionable hint for the user. */
export interface PassphraseStrengthResult {
  strength: PassphraseStrength;
  hint: string;
}

/** Count the character classes (lower, upper, digit, other) present in `value`. */
function characterClasses(value: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(value)).length;
}

/**
 * Rate an export passphrase. This is a guidance hint only — the backend
 * enforces the hard minimum length. Length dominates (a long passphrase of
 * plain words beats a short "complex" password), with character variety as a
 * secondary bonus.
 */
export function ratePassphrase(value: string): PassphraseStrengthResult {
  const length = [...value].length;
  if (length < MIN_EXPORT_PASSPHRASE_LENGTH) {
    return {
      strength: "tooShort",
      hint: `Use at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters.`,
    };
  }
  const classes = characterClasses(value);
  const uniqueChars = new Set(value).size;
  if (uniqueChars < 5) {
    return { strength: "weak", hint: "Avoid repeated characters — use several words." };
  }
  if (length >= 20 || (length >= 16 && classes >= 3)) {
    return { strength: "strong", hint: "Strong passphrase." };
  }
  if (length >= 14 || classes >= 3) {
    return { strength: "fair", hint: "Fair — a longer passphrase (4+ words) is stronger." };
  }
  return { strength: "weak", hint: "Weak — add more words or mix in digits and symbols." };
}
