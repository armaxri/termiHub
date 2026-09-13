/**
 * Split a comma-separated tag string into a trimmed, de-duplicated list.
 *
 * Shared by the macro and workflow editor dialogs, which all present tags as a
 * single free-text field (#UISF-016 consolidated three identical copies here).
 * Order is preserved (first occurrence wins); empty entries are dropped.
 *
 * @param raw the raw comma-separated field value
 * @returns the trimmed, de-duplicated tags in first-seen order
 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}
