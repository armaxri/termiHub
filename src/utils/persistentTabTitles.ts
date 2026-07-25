import type { PanelNode, TerminalTab } from "@/types/terminal";
import type { PersistentSessionEntry } from "@/types/connection";
import { getAllLeaves } from "./panelTree";

/**
 * The slice of app-store state needed to resolve the titles of the tabs
 * currently attached to a persistent session. Mirrors the "whole window" tab
 * enumeration used elsewhere (the active tab group is represented by the live
 * `rootPanel`, the others by their stored trees), so a session attached from a
 * background tab group is still resolved.
 */
export interface PersistentTabTitlesState {
  rootPanel: PanelNode;
  tabGroups: { id: string; rootPanel: PanelNode }[];
  activeTabGroupId: string;
  persistentSessions: Record<string, PersistentSessionEntry>;
}

/**
 * Resolve the display titles of the tabs currently attached to the persistent
 * session keyed by `connectionId`, in attach order. Tab ids that no longer map
 * to a live tab are dropped. Returns `[]` when the session is unknown or has no
 * attached tabs.
 */
export function persistentAttachedTabTitles(
  state: PersistentTabTitlesState,
  connectionId: string
): string[] {
  const entry = state.persistentSessions[connectionId];
  if (!entry || entry.attachedTabIds.length === 0) return [];

  const wanted = new Set(entry.attachedTabIds);
  const trees = state.tabGroups.map((g) =>
    g.id === state.activeTabGroupId ? state.rootPanel : g.rootPanel
  );
  const titleById = new Map<string, string>();
  for (const tree of trees) {
    for (const leaf of getAllLeaves(tree)) {
      for (const tab of leaf.tabs as TerminalTab[]) {
        if (wanted.has(tab.id)) titleById.set(tab.id, tab.title);
      }
    }
  }

  return entry.attachedTabIds
    .map((id) => titleById.get(id))
    .filter((title): title is string => title !== undefined);
}

/**
 * Native-title tooltip listing the attached tab names, one per line under a
 * count header (e.g. `2 tabs attached:\n• Shell\n• Logs`). Used as the hover
 * help on the sidebar run-state dot when a session has more than one tab.
 */
export function formatAttachedTabsTooltip(titles: string[]): string {
  const header = `${titles.length} tabs attached:`;
  return [header, ...titles.map((t) => `• ${t}`)].join("\n");
}
