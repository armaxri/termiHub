import { tf } from "@/i18n/catalog";

/**
 * Helpers for list-row tooltips (#5757). A list row shows the name the user
 * gave the item, its short description when there is one, and only the state
 * markers that need attention; configuration and history (host, trigger,
 * target, step previews, last run, tags) go into the row's tooltip instead.
 * See docs/copy-style.md -> "List rows".
 */

/** `Tags: a, b` for a row tooltip; `null` without tags. */
export function tagsLine(tags: readonly string[]): string | null {
  return tags.length > 0 ? tf("row.tooltip.tags", { tags: tags.join(", ") }) : null;
}

/**
 * The row's accessible description: the tooltip lines as sentences, e.g.
 * `On connect · prod. Tags: deploy`; a heading line ending in `:` runs into
 * the next (`Types: echo one. echo two`). `undefined` without lines.
 */
export function rowTooltipDescription(lines: readonly string[] | undefined): string | undefined {
  const shown = (lines ?? []).map((line) => line.trim()).filter(Boolean);
  if (shown.length === 0) return undefined;
  return shown.reduce((text, line) => `${text}${text.endsWith(":") ? " " : ". "}${line}`);
}
