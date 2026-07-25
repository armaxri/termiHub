/**
 * Window-picker helpers for the "Move to Window" tab command surface (#1901).
 *
 * The backend window registry (`list_windows`, #1900) reports each open window
 * by its runtime label only (`main`, `win-1`, …). These helpers turn that flat
 * label list into the human-readable picker the tab context menu renders: a
 * display name per window, its live tab count (#1910), and a flag marking the
 * window the menu is opened in (shown disabled, "current"). Tabs live in each
 * window's own JS context, so the count is sourced from the backend window
 * registry — every window reports its own count, which the picker reads back.
 */

import { MAIN_WINDOW_LABEL, type WindowInfo } from "@/types/window";

/** A window as presented in the "Move to Window ▸" picker. */
export interface WindowPickerEntry {
  /** The window's runtime label — the move target address. */
  label: string;
  /** Human-readable name shown in the menu. */
  name: string;
  /** Whether this is the window the picker was opened from (rendered disabled). */
  isCurrent: boolean;
  /**
   * The window's live tab count (#1910), or `null` when it has not been reported
   * yet. Rendered as a "N tabs" / "empty" hint next to the name.
   */
  tabCount: number | null;
}

/**
 * A human-readable name for a window label. The primary window is "Main Window";
 * spawned windows (`win-N`) become "Window N"; anything else falls back to its
 * raw label so an unexpected label is still addressable.
 */
export function windowDisplayName(label: string): string {
  if (label === MAIN_WINDOW_LABEL) return "Main Window";
  const match = /^win-(\d+)$/.exec(label);
  if (match) return `Window ${match[1]}`;
  return label;
}

/**
 * The short hint shown next to a window in the picker, matching the concept's
 * `move-menu` mockup: `null` (unknown, no hint yet) → `null`; `0` → "empty";
 * `1` → "1 tab"; `n` → "n tabs".
 */
export function tabCountHint(tabCount: number | null): string | null {
  if (tabCount == null) return null;
  if (tabCount <= 0) return "empty";
  return tabCount === 1 ? "1 tab" : `${tabCount} tabs`;
}

/** Numeric sort key for a window label: main first, then `win-N` ascending. */
function labelSortKey(label: string): number {
  if (label === MAIN_WINDOW_LABEL) return -1;
  const match = /^win-(\d+)$/.exec(label);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Build the ordered picker entries for the "Move to Window ▸" submenu from the
 * backend window list and the label of the window the menu was opened in. The
 * current window is included but flagged {@link WindowPickerEntry.isCurrent} so
 * the caller can render it disabled; every other window is a live move target.
 */
export function buildWindowPickerEntries(
  windows: WindowInfo[],
  currentWindowLabel: string | null
): WindowPickerEntry[] {
  return [...windows]
    .sort((a, b) => labelSortKey(a.label) - labelSortKey(b.label))
    .map((w) => ({
      label: w.label,
      name: windowDisplayName(w.label),
      isCurrent: w.label === currentWindowLabel,
      tabCount: w.tabCount ?? null,
    }));
}

/**
 * Whether any window other than the current one is open — i.e. whether moving a
 * tab into an *existing* window is possible. When false the "Move to Window ▸"
 * submenu is redundant with "Move to New Window" and the caller hides it.
 */
export function hasOtherWindows(windows: WindowInfo[], currentWindowLabel: string | null): boolean {
  return windows.some((w) => w.label !== currentWindowLabel);
}
