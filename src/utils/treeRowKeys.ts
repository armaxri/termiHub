import type React from "react";
import { isContextMenuShortcut, openContextMenuFromKeyboard } from "./contextMenuKey";

/**
 * Keyboard access to a sidebar tree row's context actions (#5181).
 *
 * The connection and agent trees put their management actions (edit/rename,
 * delete, move, …) on a right-click menu. These helpers give a focused row the
 * keyboard equivalents, shared by `ConnectionList` and `AgentNode`:
 *
 * - Shift+F10 / the ContextMenu key open the row's context menu (WKWebView on
 *   macOS does neither natively, see {@link openContextMenuFromKeyboard});
 * - F2 starts the row's rename flow, where it has one;
 * - Delete / Backspace start the row's delete flow — the same confirm (and
 *   Undo) path as the menu's Delete item.
 *
 * The keys are bound on the row element itself, so they only ever act while a
 * tree row has focus: a focused terminal keeps its function keys (#5194).
 */

/** The row actions a key can start. Each receives the focused row element. */
export interface TreeRowKeyActions {
  /** Start the rename flow (F2). Omit when the row cannot be renamed. */
  onRename?: (row: HTMLElement) => void;
  /** Start the confirmed delete (Delete / Backspace). Omit when not deletable. */
  onDelete?: (row: HTMLElement) => void;
}

/**
 * Handle a row-action key on a focused tree row. Returns `true` when the key
 * was consumed (default prevented, propagation stopped), so the caller skips
 * its own navigation handling.
 *
 * Only keys pressed on `row` itself count — never on a button nested inside it
 * — and F2 / Delete / Backspace only without modifiers, so Ctrl/Cmd chords and
 * text editing keep their meaning.
 */
export function handleTreeRowActionKey(
  e: React.KeyboardEvent<HTMLElement>,
  actions: TreeRowKeyActions,
  row: HTMLElement = e.currentTarget
): boolean {
  if (e.target !== row) return false;
  if (isContextMenuShortcut(e)) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenuFromKeyboard(row);
    return true;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  const action =
    e.key === "F2"
      ? actions.onRename
      : e.key === "Delete" || e.key === "Backspace"
        ? actions.onDelete
        : undefined;
  if (!action) return false;
  e.preventDefault();
  e.stopPropagation();
  action(row);
  return true;
}

/**
 * The `aria-keyshortcuts` value for a row offering `actions` — announces the
 * keys to screen-reader users. The context-menu key is always available.
 */
export function treeRowKeyShortcuts(actions: { rename?: boolean; delete?: boolean }): string {
  const keys = ["Shift+F10"];
  if (actions.rename) keys.push("F2");
  if (actions.delete) keys.push("Delete");
  return keys.join(" ");
}

/** The element a focus target resolves to once `row` may be gone. */
export type FocusTarget = () => HTMLElement | null;

/**
 * Capture where focus should land if `row` is removed: the row itself while it
 * is still in the document, otherwise the row now at its old position among
 * `selector` matches in `scope` (the next row, or the last one when it was the
 * last). Capture it while `row` is still rendered.
 */
export function captureNeighborFocus(
  row: HTMLElement,
  selector = '[role="treeitem"]',
  scope: Element = row.closest('[role="tree"]') ?? row.ownerDocument.body
): FocusTarget {
  const index = Array.from(scope.querySelectorAll(selector)).indexOf(row);
  return () => {
    if (row.isConnected) return row;
    if (index < 0 || !scope.isConnected) return null;
    const rows = scope.querySelectorAll<HTMLElement>(selector);
    if (rows.length === 0) return null;
    return rows[Math.min(index, rows.length - 1)];
  };
}

/** How long {@link rescueFocusAfterRemoval} keeps watching, in milliseconds. */
export const FOCUS_RESCUE_WINDOW_MS = 2000;
const FOCUS_RESCUE_POLL_MS = 25;

/**
 * After a delete, put focus back on a sensible row once it has been lost.
 *
 * Removing the focused row drops focus to `<body>`, which strands keyboard and
 * screen-reader users. The removal may land after a dialog's close animation or
 * an async store round-trip, so this watches for a short window and moves
 * focus to `target()` the first time it finds focus on `<body>`. It never pulls
 * focus back from an element that claimed it (a dialog, a new tab).
 */
export function rescueFocusAfterRemoval(
  target: FocusTarget,
  windowMs = FOCUS_RESCUE_WINDOW_MS
): void {
  const deadline = Date.now() + windowMs;
  const check = () => {
    const active = document.activeElement;
    if (!active || active === document.body) {
      const el = target();
      if (el && el.isConnected) {
        el.focus();
        return;
      }
    }
    if (Date.now() < deadline) setTimeout(check, FOCUS_RESCUE_POLL_MS);
  };
  setTimeout(check, 0);
}
