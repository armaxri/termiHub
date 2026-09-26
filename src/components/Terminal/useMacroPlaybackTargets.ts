import { useMemo } from "react";

import {
  filterConnectedTerminalTabIds,
  getActiveTab,
  resolveBroadcastTargetTabIds,
  useAppStore,
} from "@/store/appStore";
import { useBroadcastGroups } from "@/store/broadcastGroups";
import {
  useActiveTabGroupId,
  useLayoutRenderTree,
  useLayoutTabGroups,
} from "@/store/layoutSelectors";
import { useProjectedBroadcast } from "@/store/useProjectedBroadcast";
import type { TerminalTab } from "@/types/terminal";
import { resolveBroadcastGroup } from "@/utils/broadcastGroups";
import { getAllLeaves } from "@/utils/panelTree";

/** The value of the default, single-terminal target. */
export const ACTIVE_TERMINAL_TARGET = "active";

/** One selectable macro-playback target (PROD-042, #3443). */
export interface MacroPlaybackTarget {
  /** Select value (`active`, `broadcast`, `all`, `panel`, `group:<id>`). */
  value: string;
  /** Select label, carrying the live connected-terminal count. */
  label: string;
  /**
   * Connected terminal tabs this target plays into right now. Empty for
   * {@link ACTIVE_TERMINAL_TARGET}, which defers to the store's active-tab default.
   */
  tabIds: string[];
  /** Titles of {@link tabIds}, for the multi-target confirmation list. */
  titles: string[];
}

/**
 * The macro-playback target options, reusing the broadcast membership machinery:
 * the active terminal (default), the live broadcast target set, every terminal in
 * the active terminal's tab group, every terminal in its panel, and each saved
 * named broadcast group. Every multi-target option is pre-filtered through the
 * broadcast fan-out's connected-terminal filter, so the count shown is exactly
 * the number of terminals that would receive keystrokes.
 */
export function useMacroPlaybackTargets(): MacroPlaybackTarget[] {
  const rootPanel = useLayoutRenderTree();
  const tabGroups = useLayoutTabGroups();
  const activeTabGroupId = useActiveTabGroupId();
  const activeTab = useAppStore((s) => getActiveTab(s));
  const broadcast = useProjectedBroadcast();
  const groups = useBroadcastGroups();

  return useMemo(() => {
    const state = useAppStore.getState();
    const terminalTabs: TerminalTab[] = getAllLeaves(rootPanel)
      .flatMap((leaf) => leaf.tabs)
      .filter((t) => t.contentType === "terminal");
    const titleOf = new Map(terminalTabs.map((t) => [t.id, t.title]));
    const build = (value: string, label: string, requested: string[]): MacroPlaybackTarget => {
      const tabIds = filterConnectedTerminalTabIds(state, requested);
      return {
        value,
        label: `${label} (${tabIds.length} connected)`,
        tabIds,
        titles: tabIds.map((id) => titleOf.get(id) ?? id),
      };
    };

    const options: MacroPlaybackTarget[] = [
      {
        value: ACTIVE_TERMINAL_TARGET,
        label: activeTab ? `This terminal — ${activeTab.title}` : "This terminal",
        tabIds: [],
        titles: [],
      },
    ];
    if (broadcast.active) {
      options.push(build("broadcast", "Current broadcast targets", [...broadcast.targetTabIds]));
    }
    const source = activeTab?.contentType === "terminal" ? activeTab.id : null;
    if (source) {
      const resolveState = { tabGroups, activeTabGroupId, rootPanel };
      options.push(
        build("all", "All terminals", resolveBroadcastTargetTabIds(resolveState, "all", source))
      );
      options.push(
        build(
          "panel",
          "All in current panel",
          resolveBroadcastTargetTabIds(resolveState, "panel", source)
        )
      );
    }
    for (const group of groups) {
      const { tabIds } = resolveBroadcastGroup(terminalTabs, group);
      options.push(build(`group:${group.id}`, `Group "${group.name}"`, tabIds));
    }
    return options;
  }, [rootPanel, tabGroups, activeTabGroupId, activeTab, broadcast, groups]);
}
