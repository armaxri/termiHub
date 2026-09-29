import { StateCreator } from "zustand";

import type { AppState, SidebarView } from "../appStore";
import type { ShellType } from "@/types/terminal";
import { DEFAULT_LAYOUT, PersistentRunState } from "@/types/connection";
import { loadConnections, getSettings, getRecoveryWarnings } from "@/services/storage";
import { listAvailableShells, getDefaultShell, getConnectionTypes } from "@/services/api";
import type { ConnectionTypeInfo } from "@/services/api";
import { onConnectionIdsChanged, onPersistentSessionStateChanged } from "@/services/events";
import { onThemeChange } from "@/themes";
import { applyEffectiveTheme, primeActiveWorkspace } from "@/services/workspaceSettings";
import { setOverrides as setKeybindingOverrides } from "@/services/keybindings";
import { ensureAgentsSubscribed } from "@/store/agentsBridge";
import { ensureConnectionsSubscribed } from "@/store/connectionsBridge";
import { ensureSettingsSubscribed } from "@/store/settingsBridge";
import { toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Startup slice (ARCH-001/FES-011, appStore god-module split via #2881): the
 * connection-type registry, the platform default shell, the `loadFromBackend`
 * startup orchestrator and `refreshConnectionTypes`.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice. `loadFromBackend` already reaches every other domain's loader
 * through `get()` (tunnels, workspaces, macros, ...) and writes the
 * settings-driven startup state (`layoutConfig` / sidebar, `recoveryWarnings`,
 * the `persistentSessions` event fold) through the shared `set`, so moving it
 * changes no call order. The startup hydration order and the backend event
 * subscriptions are pinned by `appStore.startupOrder.test.ts`.
 */
export interface StartupSlice {
  // Connection type registry (loaded from backend at startup)
  connectionTypes: ConnectionTypeInfo[];

  // Platform default shell (detected from backend at startup)
  defaultShell: ShellType;

  loadFromBackend: () => Promise<void>;
  /**
   * Re-fetch the connection-type registry from the backend and replace
   * {@link connectionTypes}. The registry embeds backend-detected data such as
   * the local shell field's option list, so refreshing it lets a just-installed
   * shell (e.g. guided Git Bash, #1692) become selectable without an app
   * restart. A backend failure leaves the current registry untouched.
   */
  refreshConnectionTypes: () => Promise<void>;
}

export const createStartupSlice: StateCreator<AppState, [], [], StartupSlice> = (set, get) => ({
  // Connection type registry — updated by loadFromBackend()
  connectionTypes: [],

  // Platform default shell — updated by loadFromBackend()
  defaultShell: "bash",

  loadFromBackend: async () => {
    try {
      // The saved-connection / folder tree AND the agent list are
      // region-authoritative (#2401 / #2409): the backend seeds and folds the
      // `connections` and `agents` regions server-side (this
      // `load_connections_and_folders` call also re-folds both, #2389 / #2403),
      // so we only read `externalErrors` here and never seed a slice.
      const { externalErrors } = await loadConnections();
      // Prime the region subscription so `currentConnectionsView()` is populated
      // for the store's own connect / session / restore reads (which run before
      // the sidebar's `useProjectedConnections` may have mounted). Best-effort:
      // the eager transport build throws synchronously in a non-Tauri env, so
      // guard both the throw and the rejection.
      try {
        await ensureConnectionsSubscribed();
      } catch (subErr) {
        frontendLog("app_store", `connections region subscribe failed: ${errorMessage(subErr)}`);
      }
      // The persisted settings document is region-authoritative (#2404): the
      // backend seeds the `settings` region from the persisted document at
      // startup (#2386), so prime the region subscription here so
      // `currentSettingsView()` is populated for the store's own imperative reads
      // (connect / restore / line-ending). Best-effort — the eager transport
      // build throws synchronously in a non-Tauri env, so guard throw + rejection.
      try {
        await ensureSettingsSubscribed();
      } catch (subErr) {
        frontendLog("app_store", `settings region subscribe failed: ${errorMessage(subErr)}`);
      }
      // The agent list is region-authoritative (#2409): the backend seeds the
      // `agents` region from the persisted list at startup and re-folds it on the
      // `load_connections_and_folders` above (#2403), so prime the region
      // subscription here so `currentAgentsView()` is populated for the store's own
      // imperative reads (workspace hydration / restore / reconnect). Best-effort —
      // the eager transport build throws synchronously in a non-Tauri env, so guard
      // throw + rejection.
      try {
        await ensureAgentsSubscribed();
      } catch (subErr) {
        frontendLog("app_store", `agents region subscribe failed: ${errorMessage(subErr)}`);
      }
      // Still read the persisted document directly: it drives one-time startup
      // side-effects that do not live in the region view (theme apply, layout /
      // sidebar hydration, keybinding overrides, language packages / grammars).
      const settings = await getSettings();
      if (externalErrors.length > 0) {
        for (const err of externalErrors) {
          frontendLog("app_store", `Failed to load external file ${err.filePath}: ${err.error}`);
        }
      }
      const layoutConfig = settings.layout ?? DEFAULT_LAYOUT;
      const persistedView = (layoutConfig.sidebarView as SidebarView | undefined) ?? "connections";
      const sidebarView: SidebarView = persistedView === "files" ? "connections" : persistedView;
      const sidebarCollapsed = layoutConfig.sidebarCollapsed ?? false;
      set({
        layoutConfig,
        sidebarView,
        sidebarCollapsed,
      });
      // #3517: read a workspace the backend re-activated from the last session
      // first, so this single theme apply already includes its override (no
      // flash of the global theme).
      await primeActiveWorkspace();
      applyEffectiveTheme(settings);
      void get().loadSessionHistory();
      if (settings.keybindingOverrides) {
        setKeybindingOverrides(settings.keybindingOverrides);
      }
      // Register user-installed language packages / custom grammars via a
      // deferred dynamic import (PERF-001): this keeps monaco-editor + Shiki out
      // of the eager appStore/entry chunk. Only users who actually have custom
      // packages or grammars pull the editor chunk here; the common case never
      // touches it. Idempotent with the editor's own registration.
      if (settings.installedLanguagePackages?.length) {
        const packages = settings.installedLanguagePackages;
        void import("@/utils/monacoCustomLanguages").then((m) =>
          m.registerAdditionalLanguagePackages(packages)
        );
      }
      if (settings.customLanguageGrammars?.length) {
        const grammars = settings.customLanguageGrammars;
        void import("@/utils/monacoCustomLanguages")
          .then((m) => m.registerCustomGrammars(grammars))
          .catch((err: unknown) => {
            frontendLog(
              "app_store",
              `Failed to register custom grammars on startup: ${errorMessage(err)}`
            );
          });
      }
      // Re-render terminals when OS theme changes in system mode
      onThemeChange(() => {
        set({});
      });
    } catch (err) {
      frontendLog("app_store", `Failed to load connections from backend: ${errorMessage(err)}`);
      toast.error(`Failed to load connections: ${errorMessage(err)}`, {
        id: "load-connections-error",
      });
    }
    // Load connection type registry
    try {
      const connectionTypes = await getConnectionTypes();
      set({ connectionTypes });
    } catch (err) {
      frontendLog("app_store", `Failed to load connection types: ${errorMessage(err)}`);
    }
    // Detect platform default shell
    try {
      const shells = await listAvailableShells();
      const detectedDefault = await getDefaultShell();
      if (detectedDefault && shells.includes(detectedDefault)) {
        set({ defaultShell: detectedDefault as ShellType });
      } else if (shells.length > 0) {
        set({ defaultShell: shells[0] as ShellType });
      }
    } catch (err) {
      frontendLog("app_store", `Failed to detect available shells: ${errorMessage(err)}`);
    }
    // Load SSH tunnels
    get().loadTunnels();
    // Load embedded servers
    get().loadEmbeddedServers();
    // Load workspaces
    get().loadWorkspaces();
    // Load macros
    get().loadMacros();
    // Load workflows
    get().loadWorkflows();
    // Load scheduled runs (PROD-043)
    get().loadSchedules();
    // Load installed plugins (#1997)
    get().loadPlugins();
    // Load app mode (portable vs. installed) for status bar and settings display
    await get().loadAppMode();
    // Load credential store status (dialog opens on-demand when credentials are needed)
    await get().loadCredentialStoreStatus();
    // Check VS Code availability in the background
    get().checkVscodeAvailability();
    // Check for recovery warnings from corrupt config files
    try {
      const warnings = await getRecoveryWarnings();
      if (warnings.length > 0) {
        set({ recoveryWarnings: warnings, recoveryDialogOpen: true });
      }
    } catch (err) {
      frontendLog("app_store", `Failed to load recovery warnings: ${errorMessage(err)}`);
    }
    // Open tabs follow a saved connection's id when it is renamed or moved (#3579).
    onConnectionIdsChanged((changes) => get().followConnectionIdChanges(changes)).catch(
      (err: unknown) => {
        frontendLog(
          "app_store",
          `Failed to subscribe to connection id changes: ${errorMessage(err)}`
        );
      }
    );
    // Subscribe to persistent session state changes from the backend
    onPersistentSessionStateChanged((change) => {
      const { connectionId, sessionId, state: rawState, attachedTabCount, errorMessage } = change;
      const runState = rawState as PersistentRunState;
      if (runState === "stopped") {
        // Remove the entry entirely when the session stops
        set((s) => {
          const { [connectionId]: _dropped, ...remaining } = s.persistentSessions;
          return { persistentSessions: remaining };
        });
      } else {
        set((s) => {
          const existing = s.persistentSessions[connectionId];
          return {
            persistentSessions: {
              ...s.persistentSessions,
              [connectionId]: {
                connectionId,
                sessionId: sessionId ?? existing?.sessionId ?? null,
                state: runState,
                attachedTabIds: existing?.attachedTabIds ?? [],
                ...(errorMessage ? { errorMessage } : {}),
              },
            },
          };
        });
      }
      frontendLog(
        "app_store",
        `persistent-session-state: ${connectionId} → ${rawState} (tabs: ${attachedTabCount})`
      );
    }).catch((err: unknown) => {
      frontendLog(
        "app_store",
        `Failed to subscribe to persistent session events: ${errorMessage(err)}`
      );
    });
  },

  refreshConnectionTypes: async () => {
    try {
      const connectionTypes = await getConnectionTypes();
      set({ connectionTypes });
    } catch (err) {
      frontendLog("app_store", `Failed to refresh connection types: ${errorMessage(err)}`);
    }
  },
});
