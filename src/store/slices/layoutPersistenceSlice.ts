import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import {
  beginRestoreGuard,
  collectRestoreCohort,
  LAST_SESSION_SAVE_DEBOUNCE_MS,
  probeRestorePromptReachability,
  teardownAllSessions,
} from "../restoreHelpers";
import { captureAllWindows, currentWindowLabel, restoreWindowedLayout } from "../windowHelpers";
import { getComposedLayout, tabContentFromGroups } from "../layoutHelpers";
import {
  stampWindowId,
  buildWindowsMeta,
  planWindowRestore,
  hasWindowDimension,
} from "@/utils/windowPersistence";
import type { WorkspaceTabGroupDef, WorkspaceWindowDef } from "@/types/workspace";
import {
  loadWorkspace as apiLoadWorkspace,
  saveWorkspace as apiSaveWorkspace,
} from "@/services/workspaceApi";
import {
  buildTabGroupsFromWorkspace,
  captureAllTabGroups,
  getWorkspaceLeaves,
} from "@/utils/workspaceLayout";
import {
  filterSessionBySelection,
  resolveRestoreMode,
  summarizeLastSession,
  type RestorePrompt,
} from "@/utils/restoreMode";
import { newId } from "@/services/transport/ids";
import { resolveImportTrust } from "@/services/workspaceImportTrust";
import {
  saveLastSession as apiSaveLastSession,
  loadLastSession as apiLoadLastSession,
  clearLastSession as apiClearLastSession,
} from "@/services/lastSessionApi";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import {
  activateWorkspace,
  getActiveWorkspace,
  loadExistingWorkspaceSettings,
} from "@/services/workspaceSettings";
import { frontendLog } from "@/utils/frontendLog";
import { readConfigBoolean, readConfigString } from "@/utils/connectionConfigFields";
import { toast } from "@/components/ui";
import { getAllLeaves } from "@/utils/panelTree";
import { currentAgentsView } from "@/store/agentsBridge";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { currentSettingsView } from "@/store/settingsBridge";
import { errorMessage } from "@/utils/errorMessage";
import { createLayoutCommit } from "./layoutCommit";

/** Debounce timer for auto-saving the last session on layout changes. */
let lastSessionPersistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Layout-persistence slice (ARCH-001/FES-011, appStore god-module split via
 * #2881): launching and saving workspaces, and the last-session save / restore /
 * clear lifecycle with its `ask`-mode restore prompt.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice. Cross-domain calls go through `get()`, so call order is
 * unchanged. The layout commit helpers (`setLayoutLocal`, `setAndReseed`, …) come
 * from {@link createLayoutCommit}, bound to this store's `set` / `get`.
 */
export interface LayoutPersistenceSlice {
  /**
   * The id of the workspace whose launch is currently in flight, or `null` when
   * none is launching. Used to guard against re-entrant `launchWorkspace` calls
   * (double-click / repeated Play) and to disable the Launch controls in the UI.
   */
  launchingWorkspaceId: string | null;

  launchWorkspace: (workspaceId: string) => Promise<void>;

  /**
   * A workspace launch waiting on the user's confirmation because it would tear
   * down live sessions (UX-026 / UX2-002). Rendered by the app-level
   * `ConfirmWorkspaceLaunchDialog`; `count` is the number of open sessions that
   * would end. Null when no confirmation is pending.
   */
  pendingWorkspaceLaunch: { id: string; name: string; count: number } | null;

  setPendingWorkspaceLaunch: (req: { id: string; name: string; count: number } | null) => void;

  /**
   * The single guarded entry point for a user-initiated workspace launch
   * (sidebar, command palette, forwarded `--workspace`). When any tab across any
   * group holds a session it raises {@link pendingWorkspaceLaunch} instead of
   * launching; otherwise it launches directly. Only the startup CLI path calls
   * {@link launchWorkspace} directly, since nothing is live at boot.
   */
  requestLaunchWorkspace: (workspaceId: string) => void;

  /**
   * scope "all" captures all tab groups; "active" captures only the active group.
   *
   * When `overwriteId` is supplied the current layout is written under that
   * existing workspace's id — a genuine in-place update (the backend upserts by
   * id) rather than a second, indistinguishable workspace with the same name
   * (UX-027). Omit it to mint a fresh workspace.
   */
  saveCurrentAsWorkspace: (
    name: string,
    scope: "all" | "active",
    description?: string,
    overwriteId?: string
  ) => Promise<void>;

  // Last session (auto-saved layout restored on startup)
  /**
   * True while a restore/launch is settling (GAP G5, #1146). While set,
   * {@link scheduleLastSessionSave} is a no-op so a mid-restore snapshot — where
   * some tabs are still connecting or in agent-error — cannot be captured and
   * persisted over the previously-good last session. Cleared once the restored
   * cohort settles — every tab connected or failed (#4387) — with a generous
   * safety timeout as the backstop (see beginRestoreGuard).
   */
  restoreInProgress: boolean;

  /** Capture the current tab groups/layout and persist them as the last session. */
  saveLastSession: () => Promise<void>;

  /** Debounced wrapper around {@link saveLastSession} for high-frequency layout changes. */
  scheduleLastSessionSave: () => void;

  /**
   * Restore the persisted last session into the live layout. Returns true if a
   * session was restored. When `selectedIndices` is given, only the tabs at
   * those flat indices (as produced by `summarizeLastSession`) are restored —
   * the partial-restore path from the restore dialog (#1931).
   */
  restoreLastSession: (selectedIndices?: readonly number[]) => Promise<boolean>;

  /** Clear the persisted last session (e.g. when restore-on-startup is disabled). */
  clearLastSession: () => Promise<void>;

  /**
   * Pending "restore previous session?" prompt for `ask` mode: a summary of the
   * stored last session shown by the {@link SessionRestoreDialog}. `null` when
   * no prompt is showing.
   */
  restorePrompt: RestorePrompt | null;

  /**
   * `ask`-mode startup step: peek the stored last session and, when it has
   * tabs, raise {@link restorePrompt} so the dialog can offer to restore. A
   * no-op when nothing is stored.
   */
  promptRestore: () => Promise<void>;

  /**
   * Resolve the restore prompt with "Restore": optionally persist
   * `restoreLastSessionMode: "always"` (when `remember`), then restore the
   * stored session. `selectedIndices` restricts the restore to the checked tabs
   * (#1931); omitting it restores every stored tab.
   */
  confirmRestorePrompt: (remember: boolean, selectedIndices?: readonly number[]) => Promise<void>;

  /**
   * Resolve the restore prompt with "Start Fresh": optionally persist
   * `restoreLastSessionMode: "never"` (when `remember`), then clear the stored
   * session.
   */
  dismissRestorePrompt: (remember: boolean) => Promise<void>;
}

export const createLayoutPersistenceSlice: StateCreator<
  AppState,
  [],
  [],
  LayoutPersistenceSlice
> = (set, get) => {
  const { curLayout, setAndReseed } = createLayoutCommit(set, get);
  return {
    // Workspaces — `workspaces` / `activeWorkspaceName` state and the
    // `loadWorkspaces` / `saveWorkspaceToBackend` / `deleteWorkspaceFromBackend`
    // / `duplicateWorkspaceInBackend` CRUD actions are provided by
    // createWorkspacesSlice (ARCH-001/FES-011, extracted under #2077 via #2881).
    // This slice holds the layout-entangled launch / save actions.
    launchingWorkspaceId: null,

    pendingWorkspaceLaunch: null,

    setPendingWorkspaceLaunch: (req) => set({ pendingWorkspaceLaunch: req }),

    requestLaunchWorkspace: (workspaceId) => {
      const layout = getComposedLayout(get());
      const liveCount = layout.tabGroups
        .flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs))
        .filter((t) => t.sessionId).length;
      if (liveCount > 0) {
        const workspace = get().workspaces.find((ws) => ws.id === workspaceId);
        set({
          pendingWorkspaceLaunch: {
            id: workspaceId,
            name: workspace?.name ?? "this workspace",
            count: liveCount,
          },
        });
        return;
      }
      void get().launchWorkspace(workspaceId);
    },

    launchWorkspace: async (workspaceId) => {
      // In-flight guard (GAP G6, #1146): launching a workspace awaits several
      // multi-second phases (credential unlock, agent connects). Without this
      // guard a second double-click / Play press starts a concurrent launch,
      // racing the two `set(...)` calls and orphaning sessions. Ignore any
      // re-entrant launch (of this or any other workspace) while one is running.
      if (get().launchingWorkspaceId !== null) {
        frontendLog(
          "workspace",
          `launchWorkspace(${workspaceId}) ignored: a launch is already in flight`
        );
        return;
      }
      set({ launchingWorkspaceId: workspaceId });
      try {
        const definition = await apiLoadWorkspace(workspaceId);
        const state = get();

        // Collect every tab def referenced in this workspace once.
        const allTabDefs = definition.tabGroups.flatMap((g) =>
          getWorkspaceLeaves(g.layout).flatMap((leaf) => leaf.tabs)
        );

        // Collect disconnected agents referenced by agentRef tabs that use stored credentials.
        const referencedAgentIds = new Set(
          allTabDefs.filter((t) => t.agentRef).map((t) => t.agentRef!.agentId)
        );
        const disconnectedAgentsNeedingCreds = currentAgentsView().remoteAgents.filter((agent) => {
          if (!referencedAgentIds.has(agent.id)) return false;
          if (agent.connectionState === "connected") return false;
          return (
            agent.config.authMethod === "password" ||
            (agent.config.authMethod === "key" &&
              (agent.config.savePassword || Boolean(agent.config.credentialRef)))
          );
        });

        // Before opening any tabs, check whether the credential store needs to be
        // unlocked for any connection in this workspace. If so, prompt once upfront
        // so that all tabs can connect immediately after unlock rather than failing
        // and prompting individually.
        const credStatus = state.credentialStoreStatus;
        if (credStatus?.mode === "master_password" && credStatus?.status === "locked") {
          const needsStoredCredential =
            allTabDefs.some((tabDef) => {
              if (!tabDef.connectionRef) return false;
              const saved = currentConnectionsView().connections.find(
                (c) => c.id === tabDef.connectionRef
              );
              if (!saved) return false;
              const authMethod = readConfigString(saved.config, "authMethod");
              const savePassword = readConfigBoolean(saved.config, "savePassword");
              const credentialRef = readConfigString(saved.config, "credentialRef");
              return (
                authMethod === "password" ||
                (authMethod === "key" && (savePassword || Boolean(credentialRef)))
              );
            }) || disconnectedAgentsNeedingCreds.length > 0;
          if (needsStoredCredential) {
            const unlocked = await get().requestUnlock();
            if (!unlocked) return;
          }
        }

        // Connect any disconnected agents that have stored credentials so that
        // buildTabGroupsFromWorkspace can resolve their tabs to live terminals.
        //
        // `connectRemoteAgent` no longer writes `connectionState` or refreshes
        // sessions (single-writer rule, G4/#1234) — those now flow through the
        // async `agent-state-change` event, which may not have landed by the
        // time this returns. This restore path builds the layout synchronously,
        // so it tracks which agents connected (the request resolved) and drives
        // the build off that set rather than the not-yet-updated store state.
        const justConnectedAgentIds = new Set<string>();
        if (disconnectedAgentsNeedingCreds.length > 0) {
          await Promise.all(
            disconnectedAgentsNeedingCreds.map(async (agent) => {
              try {
                const resolution = await resolveConnectionCredential(
                  agent.id,
                  agent.config.authMethod,
                  agent.config.savePassword,
                  agent.config.credentialRef
                );
                const password =
                  resolution.usedStoredCredential && resolution.password
                    ? resolution.password
                    : undefined;
                await get().connectRemoteAgent(agent.id, password);
                justConnectedAgentIds.add(agent.id);
              } catch (err) {
                // Connection failure is surfaced as agent-error tabs below; keep
                // the cause, which those tabs do not carry (#4520).
                frontendLog(
                  "workspace",
                  `restore: agent ${agent.id} did not connect: ${errorMessage(err)}`
                );
              }
            })
          );
          // Populate sessions/definitions for the agents we just connected so
          // buildTabGroupsFromWorkspace can resolve their tabs now — the
          // event-driven refresh is fire-and-forget and may not have run yet.
          await Promise.all([...justConnectedAgentIds].map((id) => get().refreshAgentSessions(id)));
        }

        // After the store is unlocked (or was already unlocked), resolve stored
        // credentials for all referenced connections. Inject resolved passwords
        // into the connection configs so that Terminal.tsx can connect immediately
        // without the backend having to prompt interactively.
        const referencedIds = new Set(
          allTabDefs.filter((t) => t.connectionRef).map((t) => t.connectionRef!)
        );
        const resolvedConnections = await Promise.all(
          currentConnectionsView().connections.map(async (conn) => {
            if (!referencedIds.has(conn.id)) return conn;
            const cfg = conn.config.config;
            const authMethod = readConfigString(conn.config, "authMethod");
            const savePassword = readConfigBoolean(conn.config, "savePassword");
            if (!authMethod) return conn;
            const resolution = await resolveConnectionCredential(
              conn.id,
              authMethod,
              savePassword,
              readConfigString(conn.config, "credentialRef"),
              conn.sourceFile
            );
            if (!resolution.usedStoredCredential || !resolution.password) return conn;
            return {
              ...conn,
              config: {
                ...conn.config,
                config: { ...cfg, password: resolution.password },
              },
            };
          })
        );

        // Re-read agent state so newly-connected agents are reflected in tab
        // resolution. Agents we connected in this pass are treated as connected
        // even if their `agent-state-change` "connected" event has not yet
        // updated the store (single-writer rule, G4/#1234): a resolved connect
        // request means the backend is connected.
        const freshAgentsView = currentAgentsView();
        const agentContext = {
          agents: freshAgentsView.remoteAgents.map((a) => ({
            id: a.id,
            name: a.name,
            connected: a.connectionState === "connected" || justConnectedAgentIds.has(a.id),
          })),
          definitions: freshAgentsView.agentDefinitions,
        };

        // Window dimension (#1925): spawn + hydrate the workspace's saved
        // secondary windows and build only the main window's groups here. A
        // legacy single-window workspace spawns nothing and builds every group.
        // #4434: apply this machine's confirmations of imported commands and
        // inline configs; whatever is still unconfirmed stays held, in every
        // window the layout spans.
        const trustedGroups = await resolveImportTrust(
          definition.tabGroups,
          currentSettingsView().workspaceImportAllowlist
        );
        const plan = planWindowRestore(trustedGroups, definition.windows);
        const mainGroups = await restoreWindowedLayout(plan);
        const builtGroups = buildTabGroupsFromWorkspace(
          mainGroups,
          resolvedConnections,
          state.defaultShell,
          agentContext
        );
        // GAP G3 (#1146): a workspace that builds no launchable tabs (e.g. its
        // referenced connections were all deleted, or it was saved empty) used
        // to return silently, leaving the user with an unchanged window and no
        // explanation. `buildTabGroupsFromWorkspace` maps one group per def, so
        // "empty" means either zero groups or zero tabs across every group.
        const builtTabCount = builtGroups.reduce(
          (n, g) => n + getAllLeaves(g.rootPanel).reduce((m, leaf) => m + leaf.tabs.length, 0),
          0
        );
        if (builtGroups.length === 0 || builtTabCount === 0) {
          frontendLog(
            "workspace",
            `launchWorkspace(${workspaceId}): "${definition.name}" produced no launchable tabs`
          );
          toast.info(`Workspace "${definition.name}" had no launchable tabs`);
          return;
        }
        const firstGroup = builtGroups[0];
        // PROD-052: make this the active workspace BEFORE its tabs connect, so the
        // backend merges its default directory / env into the new local shells
        // and every window applies its theme / font overrides live.
        await activateWorkspace(definition.id);
        // GAP G1 (#1146): tear down the currently-open live sessions BEFORE the
        // `set` replaces the layout, otherwise their PTY/SSH/agent sessions are
        // dropped from the store and orphaned into the Open Connections panel.
        teardownAllSessions(get());
        // GAP G5 (#1146): raise the guard BEFORE placing the layout so the
        // auto-save subscription that fires from this `set` — and the per-tab
        // connects that follow — do not persist a mid-launch snapshot over the
        // previously-good session.
        beginRestoreGuard(set);
        setAndReseed({
          tabGroups: builtGroups,
          activeTabGroupId: firstGroup.id,
          rootPanel: firstGroup.rootPanel,
          activePanelId: firstGroup.activePanelId,
          activeWorkspaceName: definition.name,
          // Track every restored tab — including `agent-error` — in the by-id
          // content map so it resolves from `tabContent` (#2539).
          tabContent: tabContentFromGroups(builtGroups),
        });
        // GAP G4 (#1146): register the placed tabs as a cohort so a single
        // summary toast fires once every tab has connected or failed.
        const { pendingTabIds, preFailedCount } = collectRestoreCohort(builtGroups);
        get().beginRestoreCohort(pendingTabIds, preFailedCount);
      } catch (err) {
        // GAP G3 (#1146): a failed load used to be a silent console.error, so a
        // launch that could not open anything looked like nothing happened.
        frontendLog("workspace", `Failed to launch workspace ${workspaceId}: ${errorMessage(err)}`);
        toast.error("Could not launch workspace");
      } finally {
        set({ launchingWorkspaceId: null });
      }
    },

    saveCurrentAsWorkspace: async (name, scope, description, overwriteId) => {
      try {
        const state = curLayout();
        const activeGroup = state.tabGroups.find((g) => g.id === state.activeTabGroupId);
        // "active" scope saves only this window's active group — inherently a
        // single-window layout, so stamp it directly (legacy shape when it is the
        // main window). Full scope aggregates every open window (#1905/#1925) so a
        // saved multi-window layout restores its window arrangement.
        let stampedGroups: WorkspaceTabGroupDef[];
        let windows: WorkspaceWindowDef[] | undefined;
        if (scope === "active" && activeGroup) {
          const tabGroups = captureAllTabGroups(
            [activeGroup],
            state.activeTabGroupId,
            state.rootPanel,
            currentConnectionsView().connections
          );
          stampedGroups = stampWindowId(tabGroups, currentWindowLabel());
          windows = buildWindowsMeta(stampedGroups);
        } else {
          const tabGroups = captureAllTabGroups(
            state.tabGroups,
            state.activeTabGroupId,
            state.rootPanel,
            currentConnectionsView().connections
          );
          const activeGroupIndex = Math.max(
            0,
            state.tabGroups.findIndex((g) => g.id === state.activeTabGroupId)
          );
          ({ tabGroups: stampedGroups, windows } = await captureAllWindows(
            tabGroups,
            activeGroupIndex
          ));
        }
        // Reuse the caller-provided id to overwrite an existing same-named
        // workspace in place (UX-027); otherwise mint a fresh one.
        const id = overwriteId ?? newId("ws");
        // Overwriting in place re-captures only the layout: keep the workspace's
        // settings overrides (PROD-052) instead of silently dropping them.
        const settings = overwriteId ? await loadExistingWorkspaceSettings(overwriteId) : undefined;
        await apiSaveWorkspace({
          id,
          name,
          description,
          tabGroups: stampedGroups,
          ...(windows ? { windows } : {}),
          ...(settings ? { settings } : {}),
        });
        await get().loadWorkspaces();
        set({ activeWorkspaceName: name });
        await activateWorkspace(id);
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to save current layout as workspace: ${errorMessage(err)}`
        );
        throw err;
      }
    },

    restoreInProgress: false,

    saveLastSession: async () => {
      // Respect the setting at save time so toggling it takes effect immediately.
      // "never" means the user does not want a session kept, so skip the write.
      if ((await resolveRestoreMode(currentSettingsView())) === "never") return;
      const state = curLayout();
      const ownGroups = captureAllTabGroups(
        state.tabGroups,
        state.activeTabGroupId,
        state.rootPanel,
        currentConnectionsView().connections
      );
      const activeGroupIndex = Math.max(
        0,
        state.tabGroups.findIndex((g) => g.id === state.activeTabGroupId)
      );
      // Window dimension (#1905/#1925): aggregate every open window's reported
      // layout slice into one windowId-stamped document so a multi-window session
      // restores its window arrangement. This also refreshes the main window's own
      // slice in the backend authority. Falls back to this window's groups only if
      // aggregation is unavailable — a single-window app then produces the
      // byte-identical legacy shape (no windowId, no windows set).
      const { tabGroups: stampedGroups, windows } = await captureAllWindows(
        ownGroups,
        activeGroupIndex
      );
      // Only persist when there is at least one real tab to restore across every
      // window. An empty payload tells the backend to clear the stored session.
      const totalTabs = stampedGroups.reduce(
        (n, g) => n + getWorkspaceLeaves(g.layout).reduce((m, leaf) => m + leaf.tabs.length, 0),
        0
      );
      try {
        await apiSaveLastSession({
          version: "1",
          tabGroups: totalTabs > 0 ? stampedGroups : [],
          activeGroupIndex,
          ...(totalTabs > 0 && windows ? { windows } : {}),
        });
      } catch (err) {
        frontendLog("app_store", `Failed to save last session: ${errorMessage(err)}`);
        // Auto-save fires on every layout change (debounced); use a stable id so
        // repeated failures collapse into a single, replaceable toast.
        toast.error(`Failed to save session: ${errorMessage(err)}`, {
          id: "last-session-save-error",
        });
      }
    },

    scheduleLastSessionSave: () => {
      // GAP G5 (#1146): while a restore/launch is settling, a manual tab action
      // or an in-flight per-tab connect fires this via the layout subscription.
      // Saving now would recapture the whole live tree — including tabs still
      // connecting or in agent-error — over the previously-good session. Skip it
      // until the restored cohort settles (see beginRestoreGuard).
      if (get().restoreInProgress) return;
      if (lastSessionPersistTimer) clearTimeout(lastSessionPersistTimer);
      lastSessionPersistTimer = setTimeout(() => {
        lastSessionPersistTimer = null;
        void get().saveLastSession();
      }, LAST_SESSION_SAVE_DEBOUNCE_MS);
    },

    restoreLastSession: async (selectedIndices) => {
      try {
        const loaded = await apiLoadLastSession();
        if (!loaded || loaded.tabGroups.length === 0) return false;
        // Partial restore (#1931): prune the stored session to the tabs the user
        // checked before building anything. An empty selection restores nothing.
        const session = selectedIndices
          ? await filterSessionBySelection(loaded, new Set(selectedIndices))
          : loaded;
        if (session.tabGroups.length === 0) return false;
        const state = get();
        // Agents are all disconnected at startup, so agentRef tabs resolve to
        // agent-error tabs rather than silently disappearing.
        const agentsView = currentAgentsView();
        const agentContext = {
          agents: agentsView.remoteAgents.map((a) => ({
            id: a.id,
            name: a.name,
            connected: a.connectionState === "connected",
          })),
          definitions: agentsView.agentDefinitions,
        };
        // Window dimension (#1925): partition the saved groups by window, spawn +
        // hydrate the saved secondary windows, and build only the main window's
        // groups into THIS window. A legacy session has a single main entry, so
        // this spawns nothing and restores every group here (back-compat path).
        // #4434: a held imported command or inline config stays held across a
        // restart unless it was confirmed in the meantime.
        const trustedGroups = await resolveImportTrust(
          session.tabGroups,
          currentSettingsView().workspaceImportAllowlist
        );
        const plan = planWindowRestore(trustedGroups, session.windows);
        if (hasWindowDimension(session.tabGroups, session.windows)) {
          frontendLog("multi_window", `restoreLastSession: restoring ${plan.length} saved windows`);
        }
        const orderedGroups = await restoreWindowedLayout(plan);
        const builtGroups = buildTabGroupsFromWorkspace(
          orderedGroups,
          currentConnectionsView().connections,
          state.defaultShell,
          agentContext
        );
        // GAP G3 (#1146): a stored session whose tabs all fail to build (e.g.
        // every referenced connection was deleted) used to return silently,
        // leaving the user at an empty window indistinguishable from "nothing
        // was saved". `buildTabGroupsFromWorkspace` maps one group per def, so
        // "empty" means either zero groups or zero tabs across every group.
        const builtTabCount = builtGroups.reduce(
          (n, g) => n + getAllLeaves(g.rootPanel).reduce((m, leaf) => m + leaf.tabs.length, 0),
          0
        );
        if (builtGroups.length === 0 || builtTabCount === 0) {
          frontendLog(
            "workspace",
            "restoreLastSession: stored session produced no launchable tabs"
          );
          toast.info("Previous session had no launchable tabs");
          return false;
        }
        const idx = Math.min(Math.max(session.activeGroupIndex, 0), builtGroups.length - 1);
        const activeGroup = builtGroups[idx];
        // #3517: re-activate the session's workspace BEFORE its tabs connect so
        // its overrides (theme / font, and the default directory / env of new
        // local shells) are in effect again. A workspace deleted since is
        // rejected by the backend and logged, leaving none active; the next save
        // then drops the stale id. Skipped when it is already active (the
        // backend re-activates it at startup in "always" mode).
        const sessionWorkspaceId = loaded.activeWorkspaceId;
        if (sessionWorkspaceId && getActiveWorkspace()?.id !== sessionWorkspaceId) {
          await activateWorkspace(sessionWorkspaceId);
        }
        // GAP G1 (#1146): tear down any currently-open live sessions BEFORE the
        // `set` replaces the layout (e.g. a CLI-opened workspace at startup that
        // runs before restore), otherwise those sessions are orphaned.
        teardownAllSessions(get());
        // GAP G5 (#1146): raise the guard BEFORE placing the layout so the
        // auto-save subscription that fires from this very `set` — and the
        // per-tab connects that follow — are skipped until the cohort settles.
        beginRestoreGuard(set);
        setAndReseed({
          tabGroups: builtGroups,
          activeTabGroupId: activeGroup.id,
          rootPanel: activeGroup.rootPanel,
          activePanelId: activeGroup.activePanelId,
          // Track every restored tab — including `agent-error` — in the by-id
          // content map so it resolves from `tabContent` (#2539).
          tabContent: tabContentFromGroups(builtGroups),
        });
        // GAP G4 (#1146): register the placed tabs as a cohort so a single
        // summary toast fires once every tab has connected or failed.
        const { pendingTabIds, preFailedCount } = collectRestoreCohort(builtGroups);
        get().beginRestoreCohort(pendingTabIds, preFailedCount);
        return true;
      } catch (err) {
        // GAP G3 (#1146): a corrupt/failed last-session load used to be a silent
        // console.error, so a user who had a populated session opened to a blank
        // window with no explanation. Surface a recoverable error toast.
        frontendLog("workspace", `Failed to restore last session: ${errorMessage(err)}`);
        toast.error("Could not restore last session");
        return false;
      }
    },

    clearLastSession: async () => {
      if (lastSessionPersistTimer) {
        clearTimeout(lastSessionPersistTimer);
        lastSessionPersistTimer = null;
      }
      try {
        await apiClearLastSession();
      } catch (err) {
        frontendLog("app_store", `Failed to clear last session: ${errorMessage(err)}`);
        toast.error(`Failed to clear saved session: ${errorMessage(err)}`);
      }
    },

    restorePrompt: null,

    promptRestore: async () => {
      try {
        const session = await apiLoadLastSession();
        if (!session || session.tabGroups.length === 0) return;
        // Pass loaded connections so `connectionRef` tabs resolve a host/serial
        // target for the reachability probe (connections are loaded before this
        // runs at startup).
        const summary = await summarizeLastSession(session, currentConnectionsView().connections);
        // Nothing launchable → treat as "no session" and stay silent.
        if (summary.tabCount === 0) return;
        set({ restorePrompt: summary });
        // Probe each target's reachability in the background and patch the
        // prompt so the dialog can flag unavailable tabs (#1931).
        void probeRestorePromptReachability(summary, get, set);
      } catch (err) {
        // A corrupt/failed load must not wedge startup — surface it like a
        // failed restore and start fresh.
        frontendLog("workspace", `Failed to load last session for prompt: ${errorMessage(err)}`);
        toast.error("Could not load previous session");
      }
    },

    confirmRestorePrompt: async (remember, selectedIndices) => {
      const state = get();
      if (remember) {
        await state.updateSettings({
          ...currentSettingsView(),
          restoreLastSessionMode: "always",
        });
      }
      set({ restorePrompt: null });
      await get().restoreLastSession(selectedIndices);
    },

    dismissRestorePrompt: async (remember) => {
      const state = get();
      if (remember) {
        await state.updateSettings({
          ...currentSettingsView(),
          restoreLastSessionMode: "never",
        });
      }
      set({ restorePrompt: null });
      await get().clearLastSession();
    },
  };
};
