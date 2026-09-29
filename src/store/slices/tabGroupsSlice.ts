import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import { beginRestoreGuard, collectRestoreCohort } from "../restoreHelpers";
import { buildTransferAwareHandoff, removeTransferSessionsFromWindow } from "../windowHelpers";
import {
  currentLayoutSnapshot,
  generateGroupId,
  postLayoutSnapshot,
  removeTabFromLeaf,
  setTabContentEntry,
  tabContentFromGroups,
} from "../layoutHelpers";
import { TerminalTab, TabGroup } from "@/types/terminal";
import { openWindow, sendHandoffToWindow, takePendingWindowRestore } from "@/services/api";
import type { MoveWindowTarget, TabHandoffRecord, WindowRestorePayload } from "@/types/window";
import { buildTabGroupsFromWorkspace } from "@/utils/workspaceLayout";
import { newId } from "@/services/transport/ids";
import { frontendLog } from "@/utils/frontendLog";
import {
  createLeafPanel,
  findLeaf,
  getAllLeaves,
  updateLeaf,
  removeLeaf,
  simplifyTree,
} from "@/utils/panelTree";
import { mirrorLayoutIntent, mirrorLayoutMove } from "@/store/layoutBridge";
import { currentAgentsView } from "@/store/agentsBridge";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { createLayoutCommit } from "./layoutCommit";

/**
 * Tab-groups slice (ARCH-001/FES-011, appStore god-module split via #2881): the
 * workspace-level named panel trees — add / close / rename / color / activate /
 * reorder a group, move a tab into another group — and the three writers that
 * rebuild the tab trees across windows: `moveTabToWindow`, `hydrateHandoffTab`
 * and `receivePendingWindowRestore`.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice. Cross-domain calls go through `get()`, so call order is
 * unchanged. The layout commit helpers (`setLayoutLocal`, `setAndReseed`, …) come
 * from {@link createLayoutCommit}, bound to this store's `set` / `get`.
 */
export interface TabGroupsSlice {
  // Tab Groups (workspace-level named panel trees).
  // NOTE (#2562): the layout structure (`tabGroups` / `activeTabGroupId` /
  // `rootPanel` / `activePanelId`) is no longer stored — it is composed on demand
  // from the raw region `layoutView` + `layoutSplitMarks` (see `getComposedLayout`
  // / `useComposedLayout`). Reads go through `layoutSelectors` (components) or
  // `getComposedLayout(state)` (reducers); the region is the sole authority.
  /** Create a new tab group and switch to it. Returns the new group ID. */
  addTabGroup: (name?: string) => string;

  closeTabGroup: (groupId: string) => void;

  renameTabGroup: (groupId: string, name: string) => void;

  setTabGroupColor: (groupId: string, color: string | null) => void;

  setActiveTabGroup: (groupId: string) => void;

  reorderTabGroups: (fromIndex: number, toIndex: number) => void;

  /** Move a tab from the active group into a different tab group. */
  moveTabToGroup: (tabId: string, fromPanelId: string, targetGroupId: string) => void;

  /** Create a new tab group and move a tab from the active group into it atomically. */
  addTabGroupWithTab: (tabId: string, fromPanelId: string) => void;

  // Multi-window ownership (#1900 / #1964 / #3368), hand-off draining,
  // layout reporting (#1925) and the close-with-live-tabs decision (#1903) are
  // provided by WindowManagementSlice (ARCH-001/FES-011, extracted under #2077 via
  // #2881). The tab-tree writers below live in this slice: they reseed the layout
  // region.
  /**
   * Re-parent a session-bearing tab into another window (a brand-new window or
   * an existing one). The backend session keeps running; the source view is
   * disposed and the destination re-attaches with scrollback replay. This is the
   * store seam the "Move to Window" UI (#1901) builds on.
   */
  moveTabToWindow: (tabId: string, fromPanelId: string, target: MoveWindowTarget) => Promise<void>;

  /**
   * Hydrate a handed-off tab into this window's active group (destination side).
   * The tab re-attaches to its live backend session and replays scrollback.
   */
  hydrateHandoffTab: (record: TabHandoffRecord) => void;

  /**
   * Drain and hydrate the tab groups a restore-spawned secondary window was
   * seeded with (#1925). A no-op for a window not spawned by a multi-window
   * restore. Rebuilds this window's layout from the saved groups just as the
   * main window rebuilds its own in {@link restoreLastSession}.
   */
  receivePendingWindowRestore: () => Promise<void>;
}

export const createTabGroupsSlice: StateCreator<AppState, [], [], TabGroupsSlice> = (set, get) => {
  const { setLayoutLocal, layoutCoupledRollback, curLayout, setAndReseed } = createLayoutCommit(
    set,
    get
  );
  return {
    addTabGroup: (name) => {
      const newGroupId = generateGroupId();
      const newPanel = createLeafPanel();
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      let assignedName = name ?? "";
      const next = setLayoutLocal((state) => {
        const groupCount = state.tabGroups.length + 1;
        assignedName = name ?? `Group ${groupCount}`;
        const newGroup: TabGroup = {
          id: newGroupId,
          name: assignedName,
          rootPanel: newPanel,
          activePanelId: newPanel.id,
        };
        // Save current live state into the active group before switching
        const savedGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId
            ? { ...g, rootPanel: state.rootPanel, activePanelId: state.activePanelId }
            : g
        );
        return {
          tabGroups: [...savedGroups, newGroup],
          activeTabGroupId: newGroupId,
          rootPanel: newPanel,
          activePanelId: newPanel.id,
        };
      });
      // Dispatch the new group to the region via `layout.addGroup`; the mirror
      // composes the result back (#2283 slice E2). The backend assigns its own
      // group id; the overlay carries appStore's until the next reseed.
      mirrorLayoutIntent(
        "layout.addGroup",
        { name: assignedName },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
      return newGroupId;
    },

    closeTabGroup: (groupId) => {
      if (curLayout().tabGroups.length <= 1) return; // sole group: no-op (backend rejects too)
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        const newGroups = state.tabGroups.filter((g) => g.id !== groupId);

        if (groupId !== state.activeTabGroupId) {
          // Closing an inactive group — straightforward removal
          return { tabGroups: newGroups };
        }

        // Closing the active group — pick adjacent group
        const currentIdx = state.tabGroups.findIndex((g) => g.id === groupId);
        const newActiveIdx = Math.max(0, currentIdx - 1);
        const newActiveGroup = newGroups[newActiveIdx];
        return {
          tabGroups: newGroups,
          activeTabGroupId: newActiveGroup.id,
          rootPanel: newActiveGroup.rootPanel,
          activePanelId: newActiveGroup.activePanelId,
        };
      });
      // Dispatch the close to the region; the mirror composes it back (E2).
      mirrorLayoutIntent(
        "layout.closeGroup",
        { groupId },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    renameTabGroup: (groupId, name) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => ({
        tabGroups: state.tabGroups.map((g) => (g.id === groupId ? { ...g, name } : g)),
      }));
      mirrorLayoutIntent(
        "layout.renameGroup",
        { groupId, name },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    setTabGroupColor: (groupId, color) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => ({
        tabGroups: state.tabGroups.map((g) =>
          g.id === groupId ? { ...g, color: color ?? undefined } : g
        ),
      }));
      // Omit `color` when clearing so the backend's `optional_str` resolves to
      // `None` and drops the accent (matching the local `color ?? undefined`).
      mirrorLayoutIntent(
        "layout.setGroupColor",
        color != null ? { groupId, color } : { groupId },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    setActiveTabGroup: (groupId) => {
      if (groupId === curLayout().activeTabGroupId) return; // no-op
      if (!curLayout().tabGroups.some((g) => g.id === groupId)) return; // unknown group
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        const targetGroup = state.tabGroups.find((g) => g.id === groupId);
        if (!targetGroup) return state;
        // Save current live state into the currently active group
        const savedGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId
            ? { ...g, rootPanel: state.rootPanel, activePanelId: state.activePanelId }
            : g
        );
        // Follow zoom to the new group's active tab so the overlay never goes stale
        let newZoomedTabId = state.zoomedTabId;
        if (state.zoomedTabId !== null) {
          const newActivePanel = targetGroup.activePanelId
            ? findLeaf(targetGroup.rootPanel, targetGroup.activePanelId)
            : null;
          newZoomedTabId = newActivePanel?.activeTabId ?? null;
        }
        return {
          tabGroups: savedGroups,
          activeTabGroupId: groupId,
          rootPanel: targetGroup.rootPanel,
          activePanelId: targetGroup.activePanelId,
          zoomedTabId: newZoomedTabId,
        };
      });
      // Dispatch the group switch to the region; the mirror composes it back (E2).
      mirrorLayoutIntent(
        "layout.setActiveGroup",
        { groupId },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    reorderTabGroups: (fromIndex, toIndex) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        const groups = [...state.tabGroups];
        const [moved] = groups.splice(fromIndex, 1);
        groups.splice(toIndex, 0, moved);
        return { tabGroups: groups };
      });
      mirrorLayoutIntent(
        "layout.reorderGroups",
        { fromIndex, toIndex },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    moveTabToGroup: (tabId, fromPanelId, targetGroupId) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        if (targetGroupId === state.activeTabGroupId) return state;

        // Find the tab in the active group's live rootPanel
        const sourceLeaf = getAllLeaves(state.rootPanel).find((l) => l.id === fromPanelId);
        if (!sourceLeaf) return state;
        const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
        if (!tab) return state;

        // Remove tab from active group's live rootPanel
        let newRootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Clean up empty source panel (if not the sole leaf)
        const updatedSource = findLeaf(newRootPanel, fromPanelId);
        const allLeaves = getAllLeaves(newRootPanel);
        if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
          const removed = removeLeaf(newRootPanel, fromPanelId);
          newRootPanel = removed ? simplifyTree(removed) : newRootPanel;
        }

        // Find target group and add tab to its first leaf
        const targetGroupIndex = state.tabGroups.findIndex((g) => g.id === targetGroupId);
        if (targetGroupIndex === -1) return state;
        const targetGroup = state.tabGroups[targetGroupIndex];
        const targetLeaves = getAllLeaves(targetGroup.rootPanel);
        const targetLeaf = targetLeaves[0];
        if (!targetLeaf) return state;

        const movedTab: TerminalTab = { ...tab, panelId: targetLeaf.id, isActive: true };
        const newTargetRootPanel = updateLeaf(targetGroup.rootPanel, targetLeaf.id, (leaf) => ({
          ...leaf,
          tabs: [...leaf.tabs.map((t) => ({ ...t, isActive: false })), movedTab],
          activeTabId: movedTab.id,
        }));

        const newTabGroups = state.tabGroups.map((g, i) =>
          i === targetGroupIndex ? { ...g, rootPanel: newTargetRootPanel } : g
        );

        // Update active panel if the source panel was removed
        const newActivePanelId =
          state.activePanelId === fromPanelId
            ? (getAllLeaves(newRootPanel)[0]?.id ?? null)
            : state.activePanelId;

        return {
          rootPanel: newRootPanel,
          tabGroups: newTabGroups,
          activePanelId: newActivePanelId,
        };
      });
      // Commit the cross-group move to the region as a single settled-tree
      // replace (#2712): the emptied source panel is pruned, so pre/post differ
      // in panel geometry; the seed+granular path would emit the pre-prune tree
      // as an intermediate frame (a transient narrow width that corrupts terminal
      // scrollback on macOS/WKWebView). See mirrorLayoutMove.
      mirrorLayoutMove(pre, postLayoutSnapshot(prev, next));
      // Moving a tab across groups changes broadcast membership when the source
      // or a target crosses the group boundary (#1980) — re-resolve so an
      // "all"/"panel" scope drops/adds it in the source's own group.
      get().refreshBroadcastMembership();
    },

    addTabGroupWithTab: (tabId, fromPanelId) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        // Find the tab in the active group's live rootPanel
        const sourceLeaf = getAllLeaves(state.rootPanel).find((l) => l.id === fromPanelId);
        if (!sourceLeaf) return state;
        const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
        if (!tab) return state;

        // Remove tab from active group's live rootPanel
        let newSourceRootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Clean up empty source panel (if not the sole leaf)
        const updatedSource = findLeaf(newSourceRootPanel, fromPanelId);
        const allSourceLeaves = getAllLeaves(newSourceRootPanel);
        if (updatedSource && updatedSource.tabs.length === 0 && allSourceLeaves.length > 1) {
          const removed = removeLeaf(newSourceRootPanel, fromPanelId);
          newSourceRootPanel = removed ? simplifyTree(removed) : newSourceRootPanel;
        }

        // Update active panel if the source panel was removed
        const newActivePanelId =
          state.activePanelId === fromPanelId
            ? (getAllLeaves(newSourceRootPanel)[0]?.id ?? null)
            : state.activePanelId;

        // Save the updated source group state
        const savedGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId
            ? { ...g, rootPanel: newSourceRootPanel, activePanelId: newActivePanelId }
            : g
        );

        // Create the new group with the moved tab
        const newGroupId = generateGroupId();
        const newPanel = createLeafPanel();
        const movedTab: TerminalTab = { ...tab, panelId: newPanel.id, isActive: true };
        const newGroupRootPanel = updateLeaf(newPanel, newPanel.id, (leaf) => ({
          ...leaf,
          tabs: [movedTab],
          activeTabId: movedTab.id,
        }));
        const groupCount = state.tabGroups.length + 1;
        const newGroup: TabGroup = {
          id: newGroupId,
          name: `Group ${groupCount}`,
          rootPanel: newGroupRootPanel,
          activePanelId: newPanel.id,
        };

        return {
          tabGroups: [...savedGroups, newGroup],
          activeTabGroupId: newGroupId,
          rootPanel: newGroupRootPanel,
          activePanelId: newPanel.id,
        };
      });
      // Commit the "tab to new group" move as a single settled-tree replace
      // (#2712): lifting the tab out of its source panel prunes that panel, so the
      // active group's geometry changes. The seed+granular path would emit the
      // pre-prune tree as an intermediate frame — the transient narrow width that
      // destroys terminal scrollback on macOS/WKWebView. A whole-layout replace
      // carries appStore's group id (the backend keeps it under replaceGroups,
      // rather than minting its own as the granular addGroupWithTab did), so the
      // overlay and authoritative views stay structurally identical.
      mirrorLayoutMove(pre, postLayoutSnapshot(prev, next));
    },

    moveTabToWindow: async (tabId, fromPanelId, target) => {
      // Locate the tab in the active group's live rootPanel.
      const sourceLeaf = getAllLeaves(curLayout().rootPanel).find((l) => l.id === fromPanelId);
      const tab = sourceLeaf?.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      // Release this tab's transfer session ids from the source window's
      // transient `transfers` map so its rows follow ownership (#1951). The
      // Transfer Queue itself is region-authoritative and shared (#2229), so it
      // needs no carrying — the destination already sees the same rows.
      const { record, transferSessionIds } = buildTransferAwareHandoff(tab);
      const sessionId = tab.sessionId;

      // Mark the live session as moving so the source window's Terminal does NOT
      // close the backend session when its view unmounts — the destination
      // window adopts the still-running session.
      if (sessionId) {
        set((state) => ({
          movingSessionIds: state.movingSessionIds.includes(sessionId)
            ? state.movingSessionIds
            : [...state.movingSessionIds, sessionId],
        }));
      }

      // Hand the tab off to the destination window (create it, or queue + nudge).
      try {
        if (target.kind === "new") {
          await openWindow(record);
        } else {
          await sendHandoffToWindow(target.label, record);
        }
      } catch (err) {
        // Hand-off failed: clear the moving flag so a later close still tears the
        // session down rather than leaking it.
        if (sessionId) get().clearMovingSession(sessionId);
        frontendLog("multi_window", `move tab to window failed: ${String(err)}`);
        return;
      }

      // Remove the tab from the source window's tree. The Terminal unmount sees
      // the moving flag and skips closeTerminal, keeping the backend session
      // alive for the destination to re-attach and replay. Non-intent structural
      // writer (#2283 slice E2 / #2562): compute the tree and reseed the region.
      setAndReseed((state) => {
        let newRootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );
        const updatedSource = findLeaf(newRootPanel, fromPanelId);
        const allLeaves = getAllLeaves(newRootPanel);
        if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
          const removed = removeLeaf(newRootPanel, fromPanelId);
          newRootPanel = removed ? simplifyTree(removed) : newRootPanel;
        }
        const newActivePanelId =
          state.activePanelId === fromPanelId
            ? (getAllLeaves(newRootPanel)[0]?.id ?? null)
            : state.activePanelId;
        const tabGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId
            ? { ...g, rootPanel: newRootPanel, activePanelId: newActivePanelId }
            : g
        );
        // Drop the moved tab's transient `transfers` rows and mark its sessions
        // released so ongoing broadcast `transfer-progress` events do not
        // re-adopt them into this window's transient map (#1951). The shared
        // Transfer Queue region is unaffected — every window already sees it.
        const transferMoved = removeTransferSessionsFromWindow(state, transferSessionIds);
        return {
          rootPanel: newRootPanel,
          tabGroups,
          activePanelId: newActivePanelId,
          ...transferMoved,
        };
      });
    },

    hydrateHandoffTab: (record) =>
      setAndReseed((state) => {
        const h = record.tab;
        const targetLeaf = getAllLeaves(state.rootPanel)[0];
        if (!targetLeaf) return state;

        const newTab: TerminalTab = {
          id: newId("tab"),
          sessionId: h.sessionId,
          title: h.title,
          connectionType: h.connectionType,
          contentType: h.contentType,
          config: h.config,
          panelId: targetLeaf.id,
          isActive: true,
          ...(h.initialCommand ? { initialCommand: h.initialCommand } : {}),
          ...(h.persistentConnectionId ? { persistentConnectionId: h.persistentConnectionId } : {}),
          ...(h.connectionId ? { connectionId: h.connectionId } : {}),
          ...(h.spawned ? { spawned: true } : {}),
          // Repaint history from the backend ring buffer once the fresh xterm
          // (re)attaches to the live session.
          ...(h.sessionId ? { pendingScrollbackReplay: true } : {}),
        };

        const newRootPanel = updateLeaf(state.rootPanel, targetLeaf.id, (leaf) => ({
          ...leaf,
          tabs: [...leaf.tabs.map((t) => ({ ...t, isActive: false })), newTab],
          activeTabId: newTab.id,
        }));
        const tabGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId ? { ...g, rootPanel: newRootPanel } : g
        );

        // Un-release the moved tab's session so this window resumes folding its
        // live `transfer-progress` events into the transient `transfers` map
        // (#1951 / #1964). The Transfer Queue itself is region-authoritative and
        // shared (#2229), so nothing is seeded into a per-window queue on hydrate.
        const releasedTransferSessions = h.sessionId
          ? state.releasedTransferSessions.filter((id) => id !== h.sessionId)
          : state.releasedTransferSessions;

        return {
          rootPanel: newRootPanel,
          tabGroups,
          activePanelId: targetLeaf.id,
          releasedTransferSessions,
          // Track the hydrated tab's content in the by-id map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    receivePendingWindowRestore: async () => {
      let payload: WindowRestorePayload | null;
      try {
        payload = await takePendingWindowRestore();
      } catch (err) {
        frontendLog("multi_window", `takePendingWindowRestore failed: ${String(err)}`);
        return;
      }
      if (!payload || payload.tabGroups.length === 0) return;
      const state = get();
      // Agents are all disconnected at startup, so agentRef tabs resolve to
      // agent-error tabs rather than silently disappearing (mirrors restore).
      const agentsView = currentAgentsView();
      const agentContext = {
        agents: agentsView.remoteAgents.map((a) => ({
          id: a.id,
          name: a.name,
          connected: a.connectionState === "connected",
        })),
        definitions: agentsView.agentDefinitions,
      };
      const builtGroups = buildTabGroupsFromWorkspace(
        payload.tabGroups,
        currentConnectionsView().connections,
        state.defaultShell,
        agentContext
      );
      const builtTabCount = builtGroups.reduce(
        (n, g) => n + getAllLeaves(g.rootPanel).reduce((m, leaf) => m + leaf.tabs.length, 0),
        0
      );
      if (builtGroups.length === 0 || builtTabCount === 0) {
        frontendLog(
          "multi_window",
          "receivePendingWindowRestore: seeded groups produced no launchable tabs"
        );
        return;
      }
      const firstGroup = builtGroups[0];
      // GAP G5 (#1146): raise the guard before placing the layout so this
      // window's auto-report subscription does not report a mid-hydrate tree.
      beginRestoreGuard(set);
      setAndReseed({
        tabGroups: builtGroups,
        activeTabGroupId: firstGroup.id,
        rootPanel: firstGroup.rootPanel,
        activePanelId: firstGroup.activePanelId,
        // Track every restored tab — including `agent-error` — in the by-id
        // content map so it resolves from `tabContent` (#2539).
        tabContent: tabContentFromGroups(builtGroups),
      });
      const { pendingTabIds, preFailedCount } = collectRestoreCohort(builtGroups);
      get().beginRestoreCohort(pendingTabIds, preFailedCount);
    },
  };
};
