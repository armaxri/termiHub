import { useAppStore, getActiveTab } from "@/store/appStore";
import { getAllLeaves, findAdjacentLeaf, FocusDirection } from "@/utils/panelTree";
import type { LeafPanel, TerminalTab } from "@/types/terminal";

/**
 * A context-bound application command — one that acts on the currently-focused
 * panel or terminal rather than on global store state.
 *
 * Unlike the store-only commands surfaced directly in the command palette,
 * these need live context resolution (which panel is active, whether it holds a
 * terminal, how many tabs it has). Each command therefore reports whether it
 * has an applicable target right now via {@link ContextCommand.isAvailable} and
 * resolves that target at run time in {@link ContextCommand.run}.
 *
 * This registry is the single source of truth for the behaviour of these
 * actions: both the global keyboard handler ({@link useKeyboardShortcuts}) and
 * the command palette ({@link buildCommands}) run them from here, so a shortcut
 * and its palette entry can never drift apart.
 */
export interface ContextCommand {
  /**
   * Whether the command has an applicable target in the current context (e.g.
   * an adjacent panel to focus, a second tab to switch to, a focused terminal).
   * The palette uses this to disable the entry when it would be a no-op.
   */
  isAvailable: () => boolean;
  /** Execute the command against the currently-focused panel/terminal. */
  run: () => void;
}

/** Resolve the active leaf panel from live store state, or null when none. */
function activeLeaf(): LeafPanel | null {
  const { rootPanel, activePanelId } = useAppStore.getState();
  if (!activePanelId) return null;
  return getAllLeaves(rootPanel).find((p) => p.id === activePanelId) ?? null;
}

/** The active tab, but only when it is a terminal (find/clear apply). */
function activeTerminalTab(): TerminalTab | null {
  const tab = getActiveTab(useAppStore.getState());
  return tab && tab.contentType === "terminal" ? tab : null;
}

/** Close the active tab, honouring the confirm-on-shortcut setting. */
function closeActiveTab(): void {
  const panel = activeLeaf();
  if (!panel?.activeTabId) return;
  const tabId = panel.activeTabId;
  const state = useAppStore.getState();
  const confirmEnabled = state.settings.confirmCloseTabOnShortcut ?? true;
  if (confirmEnabled) {
    const activeTab = panel.tabs.find((t) => t.id === tabId);
    state.setPendingShortcutCloseConfirm({
      kind: "tab",
      tabId,
      panelId: panel.id,
      label: activeTab?.title ?? "this tab",
    });
  } else {
    state.closeTab(tabId, panel.id);
  }
}

/** Whether the active panel has more than one tab to cycle between. */
function hasMultipleTabs(): boolean {
  const panel = activeLeaf();
  return !!panel && panel.tabs.length >= 2;
}

/** Cycle the active panel's selection by `delta` tabs, wrapping around. */
function cycleTab(delta: 1 | -1): void {
  const panel = activeLeaf();
  if (!panel || panel.tabs.length < 2) return;
  const currentIdx = panel.tabs.findIndex((t) => t.id === panel.activeTabId);
  const nextIdx = (currentIdx + delta + panel.tabs.length) % panel.tabs.length;
  useAppStore.getState().setActiveTab(panel.tabs[nextIdx].id, panel.id);
}

/** Whether there is a panel adjacent to the active one in `dir`. */
function canFocusPanel(dir: FocusDirection): boolean {
  const panel = activeLeaf();
  if (!panel) return false;
  return findAdjacentLeaf(useAppStore.getState().rootPanel, panel.id, dir) !== null;
}

/** Move focus to the panel adjacent to the active one in `dir`. */
function focusPanel(dir: FocusDirection): void {
  const state = useAppStore.getState();
  const panel = activeLeaf();
  if (!panel) return;
  const target = findAdjacentLeaf(state.rootPanel, panel.id, dir);
  if (!target) return;
  state.setActivePanel(target.id);
  if (target.activeTabId) {
    window.dispatchEvent(
      new CustomEvent("termihub:focus-terminal", { detail: { tabId: target.activeTabId } })
    );
  }
}

/** Clear the focused terminal (no-op when the active tab is not a terminal). */
function clearActiveTerminal(): void {
  const tab = activeTerminalTab();
  if (!tab) return;
  window.dispatchEvent(new CustomEvent("termihub:clear-terminal", { detail: { tabId: tab.id } }));
}

/** Toggle the search bar of the focused terminal. */
function findInActiveTerminal(): void {
  const tab = activeTerminalTab();
  if (!tab) return;
  useAppStore.getState().toggleTerminalSearch(tab.id);
}

/**
 * Tear the active session tab out into a brand-new window (#1901), routed
 * through the same `moveTabToWindow` handoff seam as the tab context menu.
 */
function moveActiveTabToNewWindow(): void {
  const panel = activeLeaf();
  const tab = activeTerminalTab();
  if (!panel || !tab) return;
  void useAppStore.getState().moveTabToWindow(tab.id, panel.id, { kind: "new" });
}

/**
 * Registry of context-bound commands, keyed by keybinding action id. Consumed by
 * both the keyboard handler and the command palette so the two never diverge.
 */
export const CONTEXT_COMMANDS: Record<string, ContextCommand> = {
  "close-tab": { isAvailable: () => !!activeLeaf()?.activeTabId, run: closeActiveTab },
  "next-tab": { isAvailable: hasMultipleTabs, run: () => cycleTab(1) },
  "prev-tab": { isAvailable: hasMultipleTabs, run: () => cycleTab(-1) },
  "focus-up": { isAvailable: () => canFocusPanel("up"), run: () => focusPanel("up") },
  "focus-down": { isAvailable: () => canFocusPanel("down"), run: () => focusPanel("down") },
  "focus-left": { isAvailable: () => canFocusPanel("left"), run: () => focusPanel("left") },
  "focus-right": { isAvailable: () => canFocusPanel("right"), run: () => focusPanel("right") },
  "clear-terminal": { isAvailable: () => activeTerminalTab() !== null, run: clearActiveTerminal },
  "find-in-terminal": {
    isAvailable: () => activeTerminalTab() !== null,
    run: findInActiveTerminal,
  },
  "move-tab-to-new-window": {
    isAvailable: () => activeTerminalTab() !== null,
    run: moveActiveTabToNewWindow,
  },
};
