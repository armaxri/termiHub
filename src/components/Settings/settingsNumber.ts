/**
 * Shared helpers for the compact numeric settings controls (#5843):
 * {@link DefaultNumberInput} and {@link SettingsNumberInput}.
 */

/** Number of digits after the decimal point in `n`'s plain string form. */
function decimals(n: number): number {
  return String(n).split(".")[1]?.length ?? 0;
}

/**
 * Format a numeric setting for display: padded to the step's precision (a
 * line height of `1` with step `0.1` reads "1.0", like its hint) but never
 * rounding away the value's own decimals.
 */
export function formatSettingNumber(n: number, step?: number): string {
  const places = step === undefined ? 0 : decimals(step);
  return decimals(n) >= places ? String(n) : n.toFixed(places);
}

/** Whether a stored numeric setting follows its default. */
export function isAtDefault(value: number | undefined, defaultValue: number): boolean {
  return value === undefined || value === defaultValue;
}

/** Narrowest numeric input, in characters, so short values still have room to edit. */
export const MIN_NUMBER_CHARS = 4;
/** Widest numeric input, in characters; an unbounded range gets this width. */
export const MAX_NUMBER_CHARS = 10;

/**
 * Width of a numeric settings input, in characters, sized to the widest value
 * its range allows (#5843): a 2-digit font size gets a short box, a 7-digit
 * scrollback a wider one, never the full column. Clamped to
 * [{@link MIN_NUMBER_CHARS}, {@link MAX_NUMBER_CHARS}].
 */
export function settingsNumberChars(min?: number, max?: number, step?: number): number {
  const bounds = [min, max].filter((n): n is number => n !== undefined && Number.isFinite(n));
  if (bounds.length === 0) return MAX_NUMBER_CHARS;
  const widest = Math.max(...bounds.map((n) => formatSettingNumber(n, step).length));
  return Math.min(Math.max(widest, MIN_NUMBER_CHARS), MAX_NUMBER_CHARS);
}

/** Merge space-separated id lists, dropping empties; `undefined` when none remain. */
export function joinIds(...ids: (string | undefined)[]): string | undefined {
  const all = ids.flatMap((id) => (id ? id.split(/\s+/) : [])).filter(Boolean);
  return all.length > 0 ? Array.from(new Set(all)).join(" ") : undefined;
}
