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
import { useProjectedSessionLifecycleMaps } from "@/store/useSessionLifecycle";
import type { TerminalTab } from "@/types/terminal";
import { resolveBroadcastGroup } from "@/utils/broadcastGroups";
import { getAllLeaves } from "@/utils/panelTree";
import { terminalWhere } from "@/utils/terminalWhere";

import type { RunTargetOptions } from "./runTargetChoice";

/**
 * What the run picker can offer right now (#5818, slice 5; replaces the macro
 * playback targets of PROD-042 and the workflow "Run on…" candidates of
 * PROD-047): the active terminal, the live broadcast set, the active
 * terminal's panel, all terminals of the tab group, each saved broadcast
 * group, and every terminal of this window for a hand-picked list. Every set
 * goes through the broadcast fan-out's connected-terminal filter, so a count
 * is exactly the number of terminals that would receive input, and each
 * terminal says whether it is live. Re-renders when a session connects or
 * drops, so the live markers stay current while the picker is open.
 */
export function useRunTargets(): RunTargetOptions {
  const rootPanel = useLayoutRenderTree();
  const tabGroups = useLayoutTabGroups();
  const activeTabGroupId = useActiveTabGroupId();
  const activeTab = useAppStore((s) => getActiveTab(s));
  const spawnErrors = useAppStore((s) => s.terminalSpawnErrors);
  const broadcast = useProjectedBroadcast();
  const groups = useBroadcastGroups();
  const lifecycle = useProjectedSessionLifecycleMaps();

  return useMemo(() => {
    // `filterConnectedTerminalTabIds` reads the session view `lifecycle`
    // mirrors; naming it here re-derives the live markers when it changes.
    void lifecycle;
    const state = { ...useAppStore.getState(), terminalSpawnErrors: spawnErrors };
    const trees =
      tabGroups.length > 0
        ? tabGroups.map((g) => ({
            name: g.name,
            tree: g.id === activeTabGroupId ? rootPanel : g.rootPanel,
          }))
        : [{ name: "", tree: rootPanel }];
    const groupOf = new Map<string, string>();
    const tabs: TerminalTab[] = trees.flatMap(({ name, tree }) =>
      getAllLeaves(tree)
        .flatMap((leaf) => leaf.tabs)
        .filter((t) => t.contentType === "terminal")
        .map((t) => {
          groupOf.set(t.id, name);
          return t;
        })
    );
    const live = new Set(
      filterConnectedTerminalTabIds(
        state,
        tabs.map((t) => t.id)
      )
    );
    const onlyLive = (ids: Iterable<string>) => [...ids].filter((id) => live.has(id));
    const terminals = tabs.map((t) => ({
      id: t.id,
      title: t.title,
      live: live.has(t.id),
      where: terminalWhere(t),
      group: groupOf.get(t.id) ?? "",
    }));
    const source = activeTab?.contentType === "terminal" ? activeTab : null;
    const resolveState = { tabGroups, activeTabGroupId, rootPanel };
    const currentGroupTabs = getAllLeaves(rootPanel)
      .flatMap((leaf) => leaf.tabs)
      .filter((t) => t.contentType === "terminal")
      .map((t) => t.id);

    return {
      active: source ? { id: source.id, title: source.title, live: live.has(source.id) } : null,
      terminals,
      broadcast: broadcast.active ? onlyLive(broadcast.targetTabIds) : null,
      panel: source ? onlyLive(resolveBroadcastTargetTabIds(resolveState, "panel", source.id)) : [],
      all: onlyLive(currentGroupTabs),
      groupName: tabGroups.find((g) => g.id === activeTabGroupId)?.name ?? "",
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        tabIds: onlyLive(resolveBroadcastGroup(tabs, group).tabIds),
      })),
    };
  }, [
    rootPanel,
    tabGroups,
    activeTabGroupId,
    activeTab,
    broadcast,
    groups,
    lifecycle,
    spawnErrors,
  ]);
}
