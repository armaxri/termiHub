import { StateCreator } from "zustand";

import type { AddTabOptions, AppState } from "../appStore";
import { bestEffortOwnership } from "../windowHelpers";
import {
  createTab,
  currentLayoutSnapshot,
  generateGroupId,
  getComposedLayout,
  patchTabContentEntry,
  postLayoutSnapshot,
  removeTabFromLeaf,
  setSplitSizesInTree,
  setTabContentEntry,
} from "../layoutHelpers";
import { isResilientReconnectTabId, runOnReconnectCommand } from "../reconnectHelpers";
import {
  TerminalTab,
  TabContent,
  LeafPanel,
  ConnectionConfig,
  DropEdge,
  TerminalOptions,
  TabGroup,
  SessionCloseConfirmRequest,
} from "@/types/terminal";
import { sessionGetCapabilities, claimSession, releaseSession, sendInput } from "@/services/api";
import {
  importedCommandKey,
  importedConnectionKey,
  withImportConfirmed,
} from "@/services/workspaceImportTrust";
import { dispatchOnConnectTriggers } from "@/services/workflowTriggers";
import { notifyWorkflowSessionStarted, notifyWorkflowTabClosing } from "../workflowSessionTriggers";
import { fireAndForget } from "@/utils/frontendLog";
import { toast } from "@/components/ui";
import {
  createLeafPanel,
  findLeaf,
  findLeafByTab,
  generatePanelId,
  getAllLeaves,
  updateLeaf,
  removeLeaf,
  splitLeaf,
  simplifyTree,
  edgeToSplit,
  canSplitLeaf,
} from "@/utils/panelTree";
import {
  buildLayoutSnapshot,
  type LayoutSplitMarks,
  type LayoutView,
  mirrorLayoutIntent,
  mirrorLayoutMove,
  viewFromSnapshot,
} from "@/store/layoutBridge";
import { mirrorSessionIntent } from "@/store/sessionBridge";
import { currentSettingsView } from "@/store/settingsBridge";
import { createLayoutCommit } from "./layoutCommit";
import { prunedSessionState, prunedTabState, releaseTabFromSharedRegions } from "../tabTeardown";

/**
 * Core tabs/panel layout slice (ARCH-001/FES-011, appStore god-module split via
 * #2881): the stored layout (`layoutView` / `layoutSplitMarks`, #2562), the by-id
 * `tabContent` map, tab open / close / activate / move / reorder, panel split /
 * remove / focus / resize, drag state, tab renames, the tab's session binding and
 * the close-confirmation requests.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice. Cross-domain calls go through `get()`, so call order is
 * unchanged. The layout commit helpers (`setLayoutLocal`, `setAndReseed`, …) come
 * from {@link createLayoutCommit}, bound to this store's `set` / `get`.
 */
export interface LayoutSlice {
  // Tab drag state (shared across components for cross-group DnD)
  draggingTabId: string | null;

  setDraggingTabId: (id: string | null) => void;

  // Panels & Tabs
  /**
   * The raw `layout@<clientId>` region view — the sole stored representation of
   * the panel-tree structure (#2562). The rich `rootPanel` / `activePanelId` /
   * `tabGroups` / `activeTabGroupId` are composed from this + {@link tabContent} +
   * {@link layoutSplitMarks} on demand via `getComposedLayout`, never stored.
   */
  layoutView: LayoutView;

  /**
   * Directional split-nav marks (#448), relocated out of the layout trees (#2562).
   * `groupId → splitId → lastActiveLeafId`. Written by the `#448` subscription on
   * active-panel change; read by the layout compose. Kept out of the region view
   * because the backend does not carry these frontend-only marks.
   */
  layoutSplitMarks: LayoutSplitMarks;

  /**
   * Flat by-id map of non-structural tab content (part of #2283 — the layout
   * data-flow inversion). As the layout projection region takes over the panel
   * **tree structure**, each tab's rich **content** (title, config, connection
   * metadata, session id, all `*Meta` editor state, …) stays authoritative in
   * `appStore`, keyed by tab id — mirroring the deliberate content retention in
   * the file-browser inversion. Render composition
   * ({@link import("./useLayoutRenderTree").useLayoutRenderTree}) sources content
   * from here, falling back to the in-tree {@link TerminalTab} for any id not yet
   * present (editor/settings/etc. tabs). Populated for tabs opened via `addTab`
   * (and hydrated window-handoff tabs) and maintained on the content mutations
   * that touch those tabs (title, session id, scrollback-replay flag); pruned in
   * `closeTab`. In this behavior-preserving slice it merely duplicates content
   * the tree still holds.
   */
  tabContent: Record<string, TabContent>;

  /**
   * Open a new tab and make it active.
   * @param title Tab title.
   * @param connectionType Connection type key (e.g. `"local"`, `"ssh"`, `"remote-session"`).
   * @param config Connection config; defaults to a local shell when omitted.
   * @param options Optional tab settings — see {@link AddTabOptions}.
   * @returns The id of the created tab.
   */
  addTab: (
    title: string,
    connectionType: string,
    config?: ConnectionConfig,
    options?: AddTabOptions
  ) => string;

  editorDirtyTabs: Record<string, boolean>;

  setEditorDirty: (tabId: string, dirty: boolean) => void;

  pendingCloseRequest: { tabId: string; panelId: string } | null;

  setPendingCloseRequest: (req: { tabId: string; panelId: string } | null) => void;

  /**
   * Confirmation request shown when the user closes a tab (or tab group) via
   * keyboard shortcut while `settings.confirmCloseTabOnShortcut` is enabled.
   * A `tab` request with `unsaved: true` is the generic unsaved-changes prompt
   * for a dirty tab without a prompt of its own, raised whatever that setting
   * is (#4410). Null when no dialog is open.
   */
  pendingShortcutCloseConfirm:
    | { kind: "tab"; tabId: string; panelId: string; label: string; unsaved?: boolean }
    | { kind: "tab-group"; tabGroupId: string; label: string }
    | null;

  setPendingShortcutCloseConfirm: (
    req:
      | { kind: "tab"; tabId: string; panelId: string; label: string; unsaved?: boolean }
      | { kind: "tab-group"; tabGroupId: string; label: string }
      | null
  ) => void;

  /**
   * Confirmation request shown before tearing down a live session by closing a
   * tab (X / middle-click) or a split panel, while
   * `settings.confirmCloseLiveSession` is enabled. Null when no dialog is open.
   * The `tab` variant carries an optional `reopen` payload so the follow-up
   * toast can offer an Undo/Reopen affordance when the connection is known.
   */
  pendingSessionCloseConfirm: SessionCloseConfirmRequest | null;

  setPendingSessionCloseConfirm: (req: SessionCloseConfirmRequest | null) => void;

  /**
   * One-time notice shown when the user closes a tab attached to a persistent
   * background session, while `settings.confirmCloseAttachedTab` is enabled.
   * Closing such a tab only detaches it — the session keeps running — so the
   * notice reassures the user rather than warning of data loss. Null when no
   * dialog is open.
   */
  pendingAttachedTabCloseConfirm: { tabId: string; panelId: string; label: string } | null;

  setPendingAttachedTabCloseConfirm: (
    req: { tabId: string; panelId: string; label: string } | null
  ) => void;

  closeTab: (tabId: string, panelId: string) => void;

  setActiveTab: (tabId: string, panelId: string) => void;

  moveTab: (tabId: string, fromPanelId: string, toPanelId: string, newIndex: number) => void;

  reorderTabs: (panelId: string, oldIndex: number, newIndex: number) => void;

  splitPanel: (direction?: "horizontal" | "vertical") => void;

  removePanel: (panelId: string) => void;

  setActivePanel: (panelId: string) => void;

  setPanelSizes: (splitId: string, sizes: number[]) => void;

  splitPanelWithTab: (
    tabId: string,
    fromPanelId: string,
    targetPanelId: string,
    edge: DropEdge
  ) => void;

  getAllPanels: () => LeafPanel[];

  /** Update the backend session ID on a tab (called after the terminal session is created). */
  setTabSessionId: (tabId: string, sessionId: string | null) => void;

  /**
   * Replace a tab's connection config in place (#3089) — e.g. with credentials
   * the user re-entered after an auth rejection, so the next connect of the
   * tab uses them. Content-only; a no-op for an unknown tab.
   */
  setTabConnectionConfig: (tabId: string, config: ConnectionConfig) => void;

  /** Clear a tab's one-shot scrollback-replay flag after a re-parent (#1900). */
  clearPendingScrollbackReplay: (tabId: string) => void;

  /**
   * Confirm a tab's held imported command on this machine and run it (#4434):
   * adds its exact text to `workspaceImportAllowlist`, types it into the tab's
   * session, and clears the hold. A no-op without a held command or a session.
   */
  confirmImportedTabCommand: (tabId: string) => Promise<void>;
  /** Drop a tab's held imported command without running it (#4434). */
  dismissImportedTabCommand: (tabId: string) => void;
  /**
   * Confirm the imported inline connection config a tab is held on (#4434):
   * adds it to `workspaceImportAllowlist` and releases the tab so it connects.
   */
  confirmImportedTabConnection: (tabId: string) => Promise<void>;

  // Rename tab
  renameTab: (tabId: string, newTitle: string) => void;
}

export const createLayoutSlice: StateCreator<AppState, [], [], LayoutSlice> = (set, get) => {
  const { setLayoutLocal, layoutCoupledRollback, curLayout, setAndReseed } = createLayoutCommit(
    set,
    get
  );
  const initialPanel = createLeafPanel();
  const initialGroupId = generateGroupId();
  const initialGroup: TabGroup = {
    id: initialGroupId,
    name: "Main",
    rootPanel: initialPanel,
    activePanelId: initialPanel.id,
  };
  // The raw region view for the initial single-group layout (#2562): the sole
  // stored layout representation; the rich tree is composed from it on read.
  const initialLayoutView: LayoutView = viewFromSnapshot(
    buildLayoutSnapshot([initialGroup], initialGroupId, initialPanel, initialPanel.id)
  );
  return {
    // Layout structure (#2562): only the raw region view + directional marks are
    // stored; `tabGroups` / `activeTabGroupId` / `rootPanel` / `activePanelId` are
    // composed from these on demand (`getComposedLayout` / `layoutSelectors`).
    layoutView: initialLayoutView,

    layoutSplitMarks: {},

    draggingTabId: null,

    setDraggingTabId: (id) => set({ draggingTabId: id }),

    // Panels & Tabs — see `layoutView` / `layoutSplitMarks` above (#2562).
    // Flat by-id tab-content map (part of #2283). The initial panel is empty, so
    // it starts empty and is populated as tabs open.
    tabContent: {},

    getAllPanels: () => getAllLeaves(curLayout().rootPanel),

    clearPendingScrollbackReplay: (tabId) =>
      set((raw) => {
        // Content-only mutation (#2562): the flag is sourced from `tabContent`, so
        // patch it there — the region-derived tree recomposes with the new value.
        const leaf = findLeafByTab(getComposedLayout(raw).rootPanel, tabId);
        if (!leaf) return raw;
        return {
          tabContent: patchTabContentEntry(raw.tabContent, tabId, {
            pendingScrollbackReplay: false,
          }),
        };
      }),

    confirmImportedTabCommand: async (tabId) => {
      const tab = get().tabContent[tabId];
      const command = tab?.pendingImportedCommand;
      if (!tab || !command || !tab.sessionId) return;
      const sessionId = tab.sessionId;
      const settings = currentSettingsView();
      await get().updateSettings({
        ...settings,
        workspaceImportAllowlist: withImportConfirmed(
          settings.workspaceImportAllowlist,
          await importedCommandKey(command)
        ),
      });
      // Promote it to the tab's `initialCommand` so a saved layout or last
      // session keeps it as a confirmed command.
      set((raw) => ({
        tabContent: patchTabContentEntry(raw.tabContent, tabId, {
          pendingImportedCommand: undefined,
          initialCommand: command,
        }),
      }));
      await sendInput(sessionId, command + "\n");
    },

    dismissImportedTabCommand: (tabId) =>
      set((raw) => ({
        tabContent: patchTabContentEntry(raw.tabContent, tabId, {
          pendingImportedCommand: undefined,
        }),
      })),

    confirmImportedTabConnection: async (tabId) => {
      const tab = get().tabContent[tabId];
      if (!tab?.pendingImportedConnection) return;
      const settings = currentSettingsView();
      await get().updateSettings({
        ...settings,
        workspaceImportAllowlist: withImportConfirmed(
          settings.workspaceImportAllowlist,
          await importedConnectionKey(tab.config)
        ),
      });
      set((raw) => ({
        tabContent: patchTabContentEntry(raw.tabContent, tabId, {
          pendingImportedConnection: undefined,
        }),
      }));
    },

    setTabSessionId: (tabId, sessionId) => {
      // The tab as it stands *before* this update — used both to skip work for an
      // unknown tab and to capture the session id this tab is superseding, so a
      // replaced/cleared session releases its ownership as the new one is claimed.
      const existingTab = getAllLeaves(curLayout().rootPanel)
        .flatMap((l) => l.tabs)
        .find((t) => t.id === tabId);
      const prevSessionId = existingTab?.sessionId ?? null;

      // For remote-session tabs gaining a session ID, fetch capabilities so
      // monitoring knows whether this session supports stats collection.
      if (sessionId && existingTab?.connectionType === "remote-session") {
        fireAndForget(
          sessionGetCapabilities(sessionId).then((caps) =>
            get().setSessionCapabilities(sessionId, caps)
          ),
          `fetch capabilities for remote session ${sessionId}`
        );
      }
      set((raw) => {
        // Content-only mutation (#2562): the session id is sourced from
        // `tabContent`, so patch it there — the composed tree reflects it on read.
        const leaf = findLeafByTab(getComposedLayout(raw).rootPanel, tabId);
        if (!leaf) return raw;
        // A superseded (reconnect, fresh shell) or cleared (session ended) session
        // drops its session-keyed entries unless another tab still shows it
        // (#4313, FES2-007) — otherwise they grow with every new session id.
        const sessionPatch =
          prevSessionId && prevSessionId !== sessionId
            ? prunedSessionState(raw, prevSessionId, tabId)
            : {};
        return {
          tabContent: patchTabContentEntry(raw.tabContent, tabId, { sessionId }),
          ...sessionPatch,
        };
      });

      // Multi-window ownership (#1939): the window that renders a session owns it
      // in the backend `session → window` map (#1900). Claiming here — the single
      // choke point every rendered session flows through (terminal, file browser,
      // remote desktop, restore reconnect) — makes the Open Connections
      // owning-window badge (#1926) appear for *every* session, not only ones
      // moved between windows. Releasing a superseded/cleared session keeps the
      // map from leaking dead entries. A session mid-move is skipped so the
      // claim/release handshake with the destination window is not disturbed: the
      // destination grants first, so the source must never release the moved
      // session out from under it. Best-effort (see `bestEffortOwnership`).
      if (existingTab) {
        if (prevSessionId && prevSessionId !== sessionId && !get().isSessionMoving(prevSessionId)) {
          bestEffortOwnership(() => releaseSession(prevSessionId));
        }
        // No automatic take-over (#3368): re-binding the *same* session id (a
        // remount / reattach of a tab that already showed it) must never steal
        // the session back from a window that took it over — that would
        // ping-pong control. Only a new binding, or a session no other window
        // controls, is claimed; an evicted window regains control solely through
        // the explicit Reclaim (`reclaimWindowSession`).
        if (sessionId) {
          const owner = get().sessionOwners[sessionId];
          const ownedElsewhere = owner !== undefined && owner !== get().windowLabel;
          if (sessionId !== prevSessionId || !ownedElsewhere) {
            bestEffortOwnership(() => claimSession(sessionId));
          }
        }
      }
      // A non-null session id means this tab has connected — settle it in any
      // in-flight restore/launch cohort so the aggregate summary can fire (#1146).
      if (sessionId) {
        get().settleRestoreTab(tabId, "connected");

        // Reconnect success (#1978 / #2205 PR-B): run the optional on-reconnect
        // command once in the fresh remote shell to recover server-side context an
        // agentless reconnect otherwise loses (e.g. `tmux attach`). Only on a
        // *reconnect* (retry counter bumped) of a resilient-eligible tab — never
        // the initial connect (retry 0) and never a persistent reattach that keeps
        // its session (persistent tabs are not resilient). `runOnReconnectCommand`
        // no-ops when the tab has no command configured (e.g. agent tabs, whose
        // re-attach preserves the live session anyway).
        const isReconnectSuccess = (get().terminalRetryCounters[tabId] ?? 0) > 0;
        if (isReconnectSuccess && isResilientReconnectTabId(tabId)) {
          runOnReconnectCommand(tabId);
        }
        // Session-intents cut (#2203): the connect / reconnect succeeded — settle
        // the tab live in the region (the sole reconnect authority, #2205 PR-B).
        mirrorSessionIntent("session.connected", tabId);

        // On-connect workflow triggers (#1855): a terminal session that opened
        // for a saved connection runs any workflow bound to that connection,
        // once per session open (interactive shells only — file-browser and
        // remote-desktop tabs are excluded here). Matching/guarding lives in the
        // workflowTriggers service; the store only supplies state and the run.
        // The tab's new session can fire on-disconnect again when it ends (#3791).
        notifyWorkflowSessionStarted(tabId);
        const connectedTab = getAllLeaves(curLayout().rootPanel)
          .flatMap((l) => l.tabs)
          .find((t) => t.id === tabId);
        if (connectedTab?.contentType === "terminal" && connectedTab.connectionId) {
          dispatchOnConnectTriggers({
            connectionId: connectedTab.connectionId,
            tabId,
            sessionId,
            workflows: get().workflows,
            run: (workflowId, targetTabId) => {
              void get().runWorkflow(workflowId, { targetTabId, triggeredBy: "on-connect" });
            },
          });
          // Per-connection port forwards (PROD-023): bring up the tunnels bound
          // to this saved connection with "start with connection". The backend
          // skips any already running, so a second tab or a reconnect is benign.
          void get().startConnectionTunnels(connectedTab.connectionId);
        }
      }
    },

    setTabConnectionConfig: (tabId, config) => {
      set((raw) => ({ tabContent: patchTabContentEntry(raw.tabContent, tabId, { config }) }));
    },

    addTab: (title, connectionType, config, options) => {
      const {
        panelId,
        contentType,
        terminalOptions,
        sessionId,
        persistentConnectionId,
        connectionId,
        spawned,
        initialCommand,
      } = options ?? {};
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      let createdTabId = "";
      let addedPanelId = "";
      let addedContentType = "terminal";
      let addedSessionId: string | null = null;
      const next = setLayoutLocal((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const targetPanelId = panelId ?? state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const defaultConfig: ConnectionConfig = config ?? {
          type: "local",
          config: { shell: state.defaultShell },
        };
        const baseTab = createTab(
          title,
          connectionType,
          defaultConfig,
          targetPanelId,
          contentType,
          sessionId ?? null,
          persistentConnectionId,
          spawned,
          initialCommand
        );
        const newTab: TerminalTab = connectionId ? { ...baseTab, connectionId } : baseTab;
        createdTabId = newTab.id;
        addedPanelId = targetPanelId;
        addedContentType = newTab.contentType;
        addedSessionId = newTab.sessionId ?? null;
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        const hsEnabled =
          terminalOptions?.horizontalScrolling ??
          currentSettingsView().defaultHorizontalScrolling ??
          false;
        const tabColor = terminalOptions?.color;
        // Store per-tab terminal options (excluding horizontalScrolling and color which are tracked separately)
        const tabOpts: TerminalOptions = {};
        if (terminalOptions?.fontFamily) tabOpts.fontFamily = terminalOptions.fontFamily;
        if (terminalOptions?.fontSize != null) tabOpts.fontSize = terminalOptions.fontSize;
        if (terminalOptions?.scrollbackBuffer != null)
          tabOpts.scrollbackBuffer = terminalOptions.scrollbackBuffer;
        if (terminalOptions?.cursorStyle) tabOpts.cursorStyle = terminalOptions.cursorStyle;
        if (terminalOptions?.cursorBlink != null) tabOpts.cursorBlink = terminalOptions.cursorBlink;
        const hasTabOpts = Object.keys(tabOpts).length > 0;
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Duplicate the new tab's content into the by-id map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
          tabHorizontalScrolling: { ...state.tabHorizontalScrolling, [newTab.id]: hsEnabled },
          ...(tabColor ? { tabColors: { ...state.tabColors, [newTab.id]: tabColor } } : {}),
          ...(hasTabOpts
            ? { tabTerminalOptions: { ...state.tabTerminalOptions, [newTab.id]: tabOpts } }
            : {}),
        };
      });
      // Optimistic-fold overlay (#2283 slice D'): mirror the structural insert into
      // the region via `layout.addTab`. The frontend-generated tab id is passed to
      // the backend, so tab identity never diverges (the live xterm DOM, keyed by
      // tab id, is never remounted). The tab's rich content stays in appStore's
      // `tabContent` map / tree; the region carries only `{ id, sessionId,
      // contentType }`.
      if (createdTabId && addedPanelId) {
        mirrorLayoutIntent(
          "layout.addTab",
          {
            panelId: addedPanelId,
            tab: { id: createdTabId, sessionId: addedSessionId, contentType: addedContentType },
          },
          pre,
          postLayoutSnapshot(prev, next),
          layoutCoupledRollback(prev, next)
        );
      }
      // Record real terminal connections in the session history (#1883). Only
      // genuine connections carry a config; settings/editor/etc. tabs (which
      // pass a non-terminal contentType) are skipped. Fire-and-forget so tab
      // creation never blocks on the history write.
      if ((contentType ?? "terminal") === "terminal" && config) {
        void get().recordSession(connectionType, config);
      }
      // Dynamic membership (#1956): a terminal opened during an active broadcast
      // is auto-added under the "all"/"panel" scopes (never under "custom").
      get().refreshBroadcastMembership();
      return createdTabId;
    },

    editorDirtyTabs: {},

    setEditorDirty: (tabId, dirty) =>
      set((state) => ({ editorDirtyTabs: { ...state.editorDirtyTabs, [tabId]: dirty } })),

    pendingCloseRequest: null,

    setPendingCloseRequest: (req) => set({ pendingCloseRequest: req }),

    pendingShortcutCloseConfirm: null,

    setPendingShortcutCloseConfirm: (req) => set({ pendingShortcutCloseConfirm: req }),

    pendingSessionCloseConfirm: null,

    setPendingSessionCloseConfirm: (req) => set({ pendingSessionCloseConfirm: req }),

    pendingAttachedTabCloseConfirm: null,

    setPendingAttachedTabCloseConfirm: (req) => set({ pendingAttachedTabCloseConfirm: req }),

    closeTab: (tabId, panelId) => {
      // Snapshot the pre-close layout for the region seed (#2283 slice D').
      const prevLayout = get();
      const preLayout = currentLayoutSnapshot(prevLayout);

      // Shared teardown (#4313): drop the tab's lifecycle record from the shared
      // region (#2203 — any pending backend reconnect timer is cancelled by
      // `session.remove`) and its broadcast membership (#1955). The same helper
      // runs when a tab is moved to another window.
      releaseTabFromSharedRegions(get, tabId);

      // On-disconnect workflow triggers (#3791): closing a tab whose session is
      // still live is a user close. Checked before the tab leaves the layout.
      notifyWorkflowTabClosing({ get, set }, tabId);

      // Relinquish backend ownership of this tab's live session (#1939). A closed
      // tab's session is torn down here (or already exited), so its
      // `session → window` entry (#1900) must be dropped or it leaks a stale
      // owning-window badge (#1926). Skipped for a session mid-move — that tab is
      // removed via the move path, not closed, and the destination window now
      // owns it. Best-effort (see `bestEffortOwnership`).
      const closingSessionId = getAllLeaves(curLayout().rootPanel)
        .flatMap((l) => l.tabs)
        .find((t) => t.id === tabId)?.sessionId;
      if (closingSessionId && !get().isSessionMoving(closingSessionId)) {
        bestEffortOwnership(() => releaseSession(closingSessionId));
      }

      const closeNext = setLayoutLocal((state) => {
        // Clean up per-tab and per-session state for the closed tab (#4313):
        // every per-tab map, persistent attachedTabIds, and the session-keyed
        // maps when no other tab shows the session.
        const pruned = prunedTabState(state, tabId);

        let rootPanel = updateLeaf(state.rootPanel, panelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Dismiss zoom overlay if the zoomed tab is being closed
        const zoomedTabId = state.zoomedTabId === tabId ? null : state.zoomedTabId;

        // If leaf is now empty and not the sole leaf, remove it
        const allLeaves = getAllLeaves(rootPanel);
        const updatedLeaf = findLeaf(rootPanel, panelId);
        if (updatedLeaf && updatedLeaf.tabs.length === 0 && allLeaves.length > 1) {
          const removed = removeLeaf(rootPanel, panelId);
          rootPanel = removed ? simplifyTree(removed) : rootPanel;
          const newLeaves = getAllLeaves(rootPanel);
          const activePanelId =
            state.activePanelId === panelId ? (newLeaves[0]?.id ?? null) : state.activePanelId;
          return {
            rootPanel,
            activePanelId,
            zoomedTabId,
            ...pruned,
          };
        }

        return {
          rootPanel,
          zoomedTabId,
          ...pruned,
        };
      });

      // Optimistic-fold overlay (#2283 slice D'): mirror the structural close into
      // the region via `layout.closeTabStructure` (the structural half only —
      // session teardown stayed above). appStore is authoritative; the overlay
      // installs the post-close tree.
      mirrorLayoutIntent(
        "layout.closeTabStructure",
        { tabId },
        preLayout,
        postLayoutSnapshot(prevLayout, closeNext),
        layoutCoupledRollback(prevLayout, closeNext)
      );
    },

    setActiveTab: (tabId, panelId) => {
      // Region-authoritative op (#2283 slice E2): the reducer computes the focus
      // change (and any zoom-follow); its non-layout `zoomedTabId` is written
      // locally, the region mirror composes the layout fields back. Focuses
      // `tabId` within its leaf and repoints the active panel, following the zoom
      // overlay when it shows a tab of that leaf.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        const newRootPanel = updateLeaf(state.rootPanel, panelId, (leaf) => ({
          ...leaf,
          tabs: leaf.tabs.map((t) => ({ ...t, isActive: t.id === tabId })),
          activeTabId: tabId,
        }));

        // If the zoom overlay is showing a tab from the same panel, follow the switch
        let newZoomedTabId = state.zoomedTabId;
        if (state.zoomedTabId !== null) {
          const panelLeaf = findLeaf(state.rootPanel, panelId);
          if (panelLeaf?.tabs.some((t) => t.id === state.zoomedTabId)) {
            newZoomedTabId = tabId;
          }
        }

        return {
          rootPanel: newRootPanel,
          activePanelId: panelId,
          zoomedTabId: newZoomedTabId,
        };
      });

      // Dispatch the tab focus to the region via `layout.setActiveTab`; the mirror
      // composes it back (E2). The backend derives the leaf from the tab id.
      mirrorLayoutIntent(
        "layout.setActiveTab",
        { tabId },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    moveTab: (tabId, fromPanelId, toPanelId, newIndex) => {
      // A non-intent structural writer (no `layout.moveTab*` dispatch of its own):
      // compute the tree and reseed the region to it (#2283 slice E2 / #2562).
      setAndReseed((state) => {
        if (fromPanelId === toPanelId) return state;

        // Find and remove tab from source
        const sourceLeaf = findLeaf(state.rootPanel, fromPanelId);
        if (!sourceLeaf) return state;
        const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
        if (!tab) return state;

        const movedTab: TerminalTab = { ...tab, panelId: toPanelId, isActive: true };

        // Remove from source
        let rootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Add to destination
        rootPanel = updateLeaf(rootPanel, toPanelId, (leaf) => {
          const tabs = [...leaf.tabs.map((t) => ({ ...t, isActive: false }))];
          const idx = newIndex < 0 ? tabs.length : Math.min(newIndex, tabs.length);
          tabs.splice(idx, 0, movedTab);
          return { ...leaf, tabs, activeTabId: movedTab.id };
        });

        // Clean up empty source panel
        const updatedSource = findLeaf(rootPanel, fromPanelId);
        const allLeaves = getAllLeaves(rootPanel);
        if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
          const removed = removeLeaf(rootPanel, fromPanelId);
          rootPanel = removed ? simplifyTree(removed) : rootPanel;
        }

        return { rootPanel, activePanelId: toPanelId };
      });
    },

    reorderTabs: (panelId, oldIndex, newIndex) => {
      // Region-authoritative op (#2283 slice E2): reorder a tab within its leaf,
      // leaving focus untouched; the region mirror composes the result back.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => ({
        rootPanel: updateLeaf(state.rootPanel, panelId, (leaf) => {
          const tabs = [...leaf.tabs];
          const [moved] = tabs.splice(oldIndex, 1);
          tabs.splice(newIndex, 0, moved);
          return { ...leaf, tabs };
        }),
      }));
      mirrorLayoutIntent(
        "layout.reorderTabs",
        { panelId, oldIndex, newIndex },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    splitPanel: (direction) => {
      // Region-authoritative op (#2283 slice E2): orchestrates the shared
      // `@/utils/panelTree` helpers (the same seam the Rust store ports), so it
      // never drifts from the region's `layout.split`; the mirror composes it back.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const { activePanelId, rootPanel: preRoot } = getComposedLayout(prev);
      // Soft guard (PROD-060): block a split that would shrink the active pane
      // below the minimum usable size, rather than producing an unusable sliver.
      if (activePanelId && !canSplitLeaf(preRoot, activePanelId)) {
        toast.error("Pane too small to split further");
        return;
      }
      // Mint the new leaf and wrapping-container ids here (not inside the algebra)
      // so the very same ids are threaded through the `layout.split` intent and
      // adopted by the authoritative region — optimistic id == authoritative id,
      // eliminating the id churn a fresh backend mint would cause (#2708).
      const newPanelId = generatePanelId();
      const newSplitId = generatePanelId();
      const next = setLayoutLocal((state) => {
        const dir = direction ?? "horizontal";
        const targetId = state.activePanelId;
        if (!targetId) return state;

        const newLeaf: LeafPanel = { type: "leaf", id: newPanelId, tabs: [], activeTabId: null };
        let rootPanel = splitLeaf(state.rootPanel, targetId, newLeaf, dir, "after", newSplitId);
        rootPanel = simplifyTree(rootPanel);
        return { rootPanel, activePanelId: newLeaf.id };
      });

      // The split targets the pre-split active panel; the backend focuses its new
      // leaf, matching the reducer.
      if (activePanelId) {
        mirrorLayoutIntent(
          "layout.split",
          {
            panelId: activePanelId,
            direction: direction ?? "horizontal",
            position: "after",
            newPanelId,
            newSplitId,
          },
          pre,
          postLayoutSnapshot(prev, next),
          layoutCoupledRollback(prev, next)
        );
      }
    },

    removePanel: (panelId) => {
      // Local reducer — the retained rollback/resilience fallback. Drops a whole
      // leaf panel and simplifies; repoints focus onto the first survivor when
      // the removed panel held it.
      // The sole-leaf case is a no-op both here and in the store, so skip it.
      if (getAllLeaves(curLayout().rootPanel).length <= 1) return;
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        if (allLeaves.length <= 1) return state;

        const removed = removeLeaf(state.rootPanel, panelId);
        if (!removed) return state;
        const rootPanel = simplifyTree(removed);
        const newLeaves = getAllLeaves(rootPanel);
        const activePanelId =
          state.activePanelId === panelId ? (newLeaves[0]?.id ?? null) : state.activePanelId;
        return { rootPanel, activePanelId };
      });

      // Region-authoritative op (#2283 slice E2): the mirror composes it back.
      mirrorLayoutIntent(
        "layout.removePanel",
        { panelId },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    setActivePanel: (panelId) => {
      // Region-authoritative op (#2283 slice E2) on a hot path (every panel click
      // and keyboard-nav step): the region mirror composes the focus change back,
      // synchronously via the optimistic overlay. Zoom-follow (a non-layout field
      // set locally): when the zoom overlay shows a tab from the newly-focused
      // panel, follow the switch to that panel's active tab.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        let newZoomedTabId = state.zoomedTabId;
        if (state.zoomedTabId !== null) {
          const newPanel = findLeaf(state.rootPanel, panelId);
          newZoomedTabId = newPanel?.activeTabId ?? null;
        }
        return { activePanelId: panelId, zoomedTabId: newZoomedTabId };
      });
      mirrorLayoutIntent(
        "layout.setActivePanel",
        { panelId },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    setPanelSizes: (splitId, sizes) => {
      // Region-authoritative op (#2283 slice E2): persists a split's child
      // percentage sizes so a resize-handle drag survives remounts and workspace
      // save/restore; the mirror composes it back.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => ({
        rootPanel: setSplitSizesInTree(state.rootPanel, splitId, sizes),
      }));
      mirrorLayoutIntent(
        "layout.resize",
        { splitId, sizes },
        pre,
        postLayoutSnapshot(prev, next),
        layoutCoupledRollback(prev, next)
      );
    },

    splitPanelWithTab: (tabId, fromPanelId, targetPanelId, edge) => {
      // Region-authoritative op (#2283 slice E2) over the shared panelTree algebra;
      // the mirror composes the result back.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      // Soft guard (PROD-060): an edge drop splits the target pane; block it when
      // the target is already too small to split without producing a sliver. A
      // center drop only re-stacks the tab (no new pane) and is never blocked.
      if (edgeToSplit(edge) && !canSplitLeaf(getComposedLayout(prev).rootPanel, targetPanelId)) {
        toast.error("Pane too small to split further");
        return;
      }
      const next = setLayoutLocal((state) => {
        const splitInfo = edgeToSplit(edge);

        // Center drop: move tab to existing panel
        if (!splitInfo) {
          const sourceLeaf = findLeaf(state.rootPanel, fromPanelId);
          if (!sourceLeaf) return state;
          const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
          if (!tab) return state;

          const movedTab: TerminalTab = { ...tab, panelId: targetPanelId, isActive: true };

          let rootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
            removeTabFromLeaf(leaf, tabId)
          );
          rootPanel = updateLeaf(rootPanel, targetPanelId, (leaf) => ({
            ...leaf,
            tabs: [...leaf.tabs.map((t) => ({ ...t, isActive: false })), movedTab],
            activeTabId: movedTab.id,
          }));

          // Clean up empty source
          const updatedSource = findLeaf(rootPanel, fromPanelId);
          const allLeaves = getAllLeaves(rootPanel);
          if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
            const removed = removeLeaf(rootPanel, fromPanelId);
            rootPanel = removed ? simplifyTree(removed) : rootPanel;
          }

          return { rootPanel, activePanelId: targetPanelId };
        }

        // Edge drop: create new panel via split
        const sourceLeaf = findLeaf(state.rootPanel, fromPanelId);
        if (!sourceLeaf) return state;
        const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
        if (!tab) return state;

        const newLeaf = createLeafPanel();
        const movedTab: TerminalTab = { ...tab, panelId: newLeaf.id, isActive: true };
        newLeaf.tabs = [movedTab];
        newLeaf.activeTabId = movedTab.id;

        // Remove tab from source
        let rootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Clean up empty source before splitting (unless source IS the target)
        if (fromPanelId !== targetPanelId) {
          const updatedSource = findLeaf(rootPanel, fromPanelId);
          const allLeaves = getAllLeaves(rootPanel);
          if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
            const removed = removeLeaf(rootPanel, fromPanelId);
            rootPanel = removed ? simplifyTree(removed) : rootPanel;
          }
        }

        // Split the target
        rootPanel = splitLeaf(
          rootPanel,
          targetPanelId,
          newLeaf,
          splitInfo.direction,
          splitInfo.position
        );
        rootPanel = simplifyTree(rootPanel);

        return { rootPanel, activePanelId: newLeaf.id };
      });

      // Commit the move to the region as a single settled-tree replace (#2712).
      // A move prunes the emptied source leaf (center = merge into the target
      // stack; edge = split the target), so pre/post differ in panel geometry and
      // width. Dispatching the granular `layout.moveTab` on a `preSnapshot` seed
      // would make the region emit the pre-prune two-panel tree as an intermediate
      // frame — a transient ~40-col width that reflows xterm and destroys terminal
      // scrollback on macOS/WKWebView. Installing the settled tree in one commit
      // keeps the optimistic and authoritative views structurally identical, so
      // no intermediate narrow width is ever produced. See mirrorLayoutMove.
      mirrorLayoutMove(pre, postLayoutSnapshot(prev, next));
    },

    // Rename tab
    renameTab: (tabId, newTitle) =>
      set((raw) => {
        // Content-only mutation (#2562): the title is sourced from `tabContent`, so
        // patch it there — the composed tree reflects the rename on read.
        const leaf = findLeafByTab(getComposedLayout(raw).rootPanel, tabId);
        if (!leaf) return raw;
        return {
          tabContent: patchTabContentEntry(raw.tabContent, tabId, { title: newTitle }),
        };
      }),
  };
};
