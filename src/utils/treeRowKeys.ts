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

/**
 * The element focus should land on once `row` may be gone — call it to
 * resolve. It also carries the row it was captured for and the tree that row
 * lives in, so {@link rescueFocusAfterRemoval} can stay scoped to that tree.
 */
export interface FocusTarget {
  (): HTMLElement | null;
  /** The row whose removal this target covers. */
  readonly row: HTMLElement;
  /** The tree the row lives in, looked up afresh; `null` once it is gone. */
  readonly scope: () => Element | null;
}

/**
 * Capture where focus should land if `row` is removed: the row itself while it
 * is still in the document, otherwise the row now at its old position among
 * `selector` matches in `scope` (the next row, or the last one when it was the
 * last). Capture it while `row` is still rendered.
 *
 * `scope` defaults to the row's `role="tree"`. Pass a resolver when the tree
 * element itself may be re-created by the delete, so it is looked up afresh.
 * Never pass the whole document: the target would then resolve to a matching
 * row of an unrelated tree.
 */
export function captureNeighborFocus(
  row: HTMLElement,
  selector = '[role="treeitem"]',
  scope?: Element | (() => Element | null)
): FocusTarget {
  const fixed = typeof scope === "function" ? null : (scope ?? row.closest('[role="tree"]'));
  const resolve = typeof scope === "function" ? scope : () => fixed;
  const initial = resolve();
  const index = initial ? Array.from(initial.querySelectorAll(selector)).indexOf(row) : -1;
  const target = () => {
    if (row.isConnected) return row;
    const current = resolve();
    if (index < 0 || !current?.isConnected) return null;
    const rows = current.querySelectorAll<HTMLElement>(selector);
    if (rows.length === 0) return null;
    return rows[Math.min(index, rows.length - 1)];
  };
  return Object.assign(target, {
    row,
    scope: () => {
      const current = resolve();
      return current?.isConnected ? current : null;
    },
  });
}

/**
 * Resolve the agent tree for `agentId` (its `data-agent-tree` element) — a
 * {@link captureNeighborFocus} scope that survives the tree being re-created.
 */
export function agentTreeScope(agentId: string): () => Element | null {
  return () =>
    Array.from(document.querySelectorAll("[data-agent-tree]")).find(
      (el) => el.getAttribute("data-agent-tree") === agentId
    ) ?? null;
}

/** How long {@link rescueFocusAfterRemoval} keeps watching at most, in milliseconds. */
export const FOCUS_RESCUE_WINDOW_MS = 2000;
const FOCUS_RESCUE_POLL_MS = 25;
/**
 * How long a rescue keeps watching after its delete settled with the row still
 * rendered — long enough for the settled store update to reach the DOM.
 */
const FOCUS_RESCUE_SETTLE_GRACE_MS = 100;

/** A running {@link rescueFocusAfterRemoval}. */
export interface FocusRescue {
  /** Stop watching now (the delete was undone, or the tree is going away). */
  cancel: () => void;
}

export interface FocusRescueOptions {
  /** Upper bound on the watch, in ms. Defaults to {@link FOCUS_RESCUE_WINDOW_MS}. */
  windowMs?: number;
  /**
   * Settles once the delete has been applied or has failed. If the row is still
   * rendered shortly after, the delete did not remove it and the rescue ends.
   */
  settled?: PromiseLike<unknown> | void;
}

/** The one rescue that may be running: focus is global, so a new one replaces it. */
let activeRescue: FocusRescue | null = null;

/**
 * After a delete, put focus back on a sensible row once it has been lost.
 *
 * Removing the focused row drops focus to `<body>`, which strands keyboard and
 * screen-reader users. The removal may land after a dialog's close animation or
 * an async store round-trip, so this watches briefly and, whenever focus is
 * stranded (on `<body>`, nowhere, or on the removed row), moves it to
 * `target()` — first back onto the row while it still exists, then onto its
 * neighbour once it is gone.
 *
 * The rescue acts only for the removal it was started for (#5248). It ends:
 * - once the row is gone and focus has landed in its tree;
 * - as soon as anything other than the row takes focus (a dialog, a new tab,
 *   the user clicking elsewhere, an Undo button) — it never pulls focus back;
 * - when `settled` resolves and the row is still there (the delete failed or
 *   was a no-op), or on {@link FocusRescue.cancel} (the delete was undone);
 * - when its tree is gone, when a newer rescue starts, or after `windowMs`.
 */
export function rescueFocusAfterRemoval(
  target: FocusTarget,
  { windowMs = FOCUS_RESCUE_WINDOW_MS, settled }: FocusRescueOptions = {}
): FocusRescue {
  activeRescue?.cancel();
  const { row } = target;
  const doc = row.ownerDocument;
  let deadline = Date.now() + windowMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const onFocusIn = (event: FocusEvent) => {
    // The row regaining focus (a closing dialog handing it back, or this rescue
    // putting it there) keeps the watch going; anything else claims focus.
    if (event.target !== row) stop();
  };

  const rescue: FocusRescue = { cancel: () => stop() };

  function stop() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    doc.removeEventListener("focusin", onFocusIn, true);
    if (activeRescue === rescue) activeRescue = null;
  }

  function check() {
    if (done) return;
    const scope = target.scope();
    if (!scope) return stop();
    const active = doc.activeElement;
    const stranded = !active || active === doc.body || (active === row && !row.isConnected);
    if (stranded) {
      const el = target();
      if (el?.isConnected) el.focus();
    }
    if (!row.isConnected && doc.activeElement && scope.contains(doc.activeElement)) return stop();
    if (Date.now() >= deadline) return stop();
    timer = setTimeout(check, FOCUS_RESCUE_POLL_MS);
  }

  doc.addEventListener("focusin", onFocusIn, true);
  activeRescue = rescue;
  if (settled && typeof settled.then === "function") {
    const onSettled = () => {
      if (row.isConnected) deadline = Math.min(deadline, Date.now() + FOCUS_RESCUE_SETTLE_GRACE_MS);
    };
    settled.then(onSettled, onSettled);
  }
  timer = setTimeout(check, 0);
  return rescue;
}
