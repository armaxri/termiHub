/**
 * The short user-written description a list item can carry (#5757):
 * connections, workflows, macros and schedules. A list row shows it muted
 * under the name, so it is one line and short; configuration never goes in it
 * (see docs/copy-style.md -> "List rows").
 */

/** Longest description the editors accept, in characters. */
export const ITEM_DESCRIPTION_MAX_LENGTH = 80;

/**
 * Normalise an editor's description input for saving: line breaks become
 * spaces, runs of whitespace collapse, and an empty result is `undefined`
 * (absent = no description, so older files round-trip unchanged).
 */
export function normalizeItemDescription(value: string | null | undefined): string | undefined {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}
