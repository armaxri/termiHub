import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import {
  createTab,
  patchTabContentEntry,
  setTabContentEntry,
  tabContentFromGroups,
} from "../layoutHelpers";
import { resolveEditorSessionKey } from "../tabQueries";
import {
  TerminalTab,
  PanelNode,
  ConnectionConfig,
  EditorTabMeta,
  EditorSessionRef,
  ConnectionEditorMeta,
  TunnelEditorMeta,
  WorkspaceEditorMeta,
  NetworkDiagnosticMeta,
  PluginDetailMeta,
  NetworkTool,
} from "@/types/terminal";
import type { ContainerSpawn, ShellSpawn } from "@/services/api";
import { quotePath } from "@/utils/quotePath";
import { getAllLeaves, updateLeaf } from "@/utils/panelTree";
import { currentAgentsView } from "@/store/agentsBridge";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { createLayoutCommit } from "./layoutCommit";

/**
 * Tab-openers slice (ARCH-001/FES-011, appStore god-module split via #2881): the
 * actions that open (or focus) a singleton or content tab on behalf of another
 * domain — settings, log viewer, network diagnostics, transfer view, editors,
 * connection / agent-definition / tunnel / workspace editors, plugin detail,
 * spawned shells and containers — plus `resolveAgentErrorTabs`.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice. Cross-domain calls go through `get()`, so call order is
 * unchanged. The layout commit helpers (`setLayoutLocal`, `setAndReseed`, …) come
 * from {@link createLayoutCommit}, bound to this store's `set` / `get`.
 */
export interface TabOpenersSlice {
  /**
   * Open a Docker session tab for a resolved external container spawn (#1446).
   * Reuses the standard {@link addTab} open path with the spawn's Docker
   * settings + tab title and marks the tab `spawned` (no saved connection id).
   * Returns the created tab id.
   */
  openSpawnedContainer: (spawn: ContainerSpawn) => string;

  /**
   * Open a session tab for a resolved external local/WSL/SSH spawn (#1365 local,
   * #1511 WSL/SSH). Branches on the spawn's `type`: a `local` shell or `wsl`
   * distribution opens at the resolved `startingDirectory`; an `ssh` saved
   * connection opens and `cd`s into `cdPath` after connect (via the tab's
   * `initialCommand`). Reuses the standard {@link addTab} open path and marks the
   * tab `spawned` (no saved connection id). Returns the created tab id.
   */
  openSpawnedShell: (spawn: ShellSpawn) => string;

  /**
   * Open (or focus the existing) Settings tab. An optional `target` deep-links
   * into a specific category — and, for the Plugins category, an optional plugin
   * to scroll to and highlight (#2000). The target is consumed once by the
   * settings panel via {@link pendingSettingsCategory}/{@link
   * pendingSettingsPluginId}; passing none leaves the current category alone.
   */
  openSettingsTab: (target?: { category?: string; pluginId?: string }) => void;

  /**
   * Category the Settings panel should switch to when it next reads this, or
   * `null` for no pending navigation. Set by {@link openSettingsTab} and cleared
   * by the panel after it applies (#2000).
   */
  pendingSettingsCategory: string | null;

  /**
   * Plugin the Plugins settings section should scroll to and highlight when it
   * next reads this, or `null`. Set by {@link openSettingsTab} and cleared by the
   * panel after it applies (#2000).
   */
  pendingSettingsPluginId: string | null;

  openLogViewerTab: () => void;

  openNetworkDiagnosticTab: (
    tool: NetworkTool,
    prefillHost?: string,
    connectionId?: string
  ) => void;

  /**
   * Open (or focus) the dual-pane local ↔ remote transfer view for the terminal
   * tab `remoteTabId` (PROD-007, #3558); `null` opens it with no remote chosen.
   */
  openTransferViewTab: (meta: import("@/types/terminal").TransferViewMeta) => void;

  /**
   * Open (or focus) an editor tab for a file.
   *
   * A remote tab is backed by the protocol-agnostic session layer via
   * `sessionBrowser` (SSH, FTP, Docker, agent sessions — #1557 / #2422).
   */
  openEditorTab: (
    filePath: string,
    isRemote: boolean,
    permissions?: string | null,
    sessionBrowser?: EditorSessionRef
  ) => void;

  /**
   * Open a new "scratch" editor tab seeded with in-memory content that is not
   * backed by a file on disk (e.g. captured terminal output). The tab is
   * treated as unsaved until the user saves it via Save As. Each call creates a
   * new tab — scratch buffers are never deduplicated.
   */
  openScratchEditorTab: (title: string, fileName: string, content: string) => void;

  openConnectionEditorTab: (connectionId: string, folderId?: string | null) => void;

  openAgentDefinitionEditorTab: (
    agentId: string,
    definitionId: string,
    folderId?: string | null
  ) => void;

  // Remote agents — the ordered agent list plus each agent's live sessions, saved
  // definitions and folders are region-authoritative (#2409): they live only in the
  // shared `agents` projection region, read via `useProjectedAgents()` /
  // `currentAgentsView()`. The lifecycle / definition / folder actions and the
  // per-client update sub-slices (`agentUpdates` / `agentUpdatesDismissed` /
  // `agentUpdatePending`) are provided by AgentsSlice (ARCH-001/FES-011,
  // extracted under #2077 via #2881). `resolveAgentErrorTabs` lives in this slice
  // because it rewrites the tab trees (tabs/layout domain).
  /** Convert all agent-error tabs for the given agent into live terminal tabs after reconnect. */
  resolveAgentErrorTabs: (agentId: string) => void;

  // SSH Tunnels — tunnel data + lifecycle live in TunnelSlice (#2077); the
  // tab-opening action lives here as it belongs to the panel/tab domain.
  /**
   * Open (or focus) the tunnel-editor tab for `tunnelId` (`null` = new tunnel).
   * `options.sshConnectionId` pre-selects the SSH connection of a NEW tunnel —
   * used by the connection editor's "Port Forwarding" section (PROD-023).
   */
  openTunnelEditorTab: (tunnelId: string | null, options?: { sshConnectionId?: string }) => void;

  // Plugins — installed-plugin list, derived backend/theme registries, and the
  // load/install/enable/disable/settings actions live in PluginsSlice (#2115).
  // `selectPlugin` lives here: it opens the plugin-detail tab via the shared
  // `createTab` factory (same as `openTunnelEditorTab`).
  /**
   * Select a plugin in the Plugins sidebar: records {@link selectedPluginId} and
   * opens (or updates, and focuses) the single plugin-detail tab in the main area.
   */
  selectPlugin: (pluginId: string) => void;

  // Workspaces — the list/CRUD surface (`workspaces`, `activeWorkspaceName`,
  // `loadWorkspaces` / `saveWorkspaceToBackend` / `deleteWorkspaceFromBackend` /
  // `duplicateWorkspaceInBackend`) is provided by createWorkspacesSlice
  // (ARCH-001/FES-011, extracted under #2077 via #2881). The workspace-editor
  // tab opener lives here; launch / save live in LayoutPersistenceSlice.
  openWorkspaceEditorTab: (workspaceId: string | null) => void;
}

export const createTabOpenersSlice: StateCreator<AppState, [], [], TabOpenersSlice> = (
  set,
  get
) => {
  const { setAndReseed } = createLayoutCommit(set, get);
  return {
    openSpawnedContainer: (spawn) =>
      get().addTab(
        spawn.title,
        "docker",
        { type: "docker", config: spawn.settings },
        { contentType: "terminal", spawned: true }
      ),

    openSpawnedShell: (spawn) => {
      // The resolved backend type decides which session opens: a local shell, a
      // WSL distribution, or an SSH saved connection (#1511). Legacy payloads
      // without a `type` are treated as local (#1365).
      const sessionType = spawn.type ?? "local";
      // SSH cannot set a start cwd at spawn, so `cd` into the target after the
      // session connects, via the tab's `initialCommand` (Terminal.tsx runs it
      // through `send_input`). Local/WSL set a real startingDirectory instead.
      const initialCommand = spawn.cdPath ? `cd ${quotePath(spawn.cdPath)}` : undefined;
      return get().addTab(
        spawn.title,
        sessionType,
        { type: sessionType, config: spawn.settings },
        { contentType: "terminal", spawned: true, initialCommand }
      );
    },

    pendingSettingsCategory: null,

    pendingSettingsPluginId: null,

    openSettingsTab: (target) =>
      setAndReseed((state) => {
        // Deep-link target (#2000): a null category leaves the panel's current
        // category alone, so a plain open never resets it to General.
        const nav = {
          pendingSettingsCategory: target?.category ?? null,
          pendingSettingsPluginId: target?.pluginId ?? null,
        };
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing settings tab
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find((t) => t.contentType === "settings");
          if (existing) {
            // Activate the existing settings tab
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { ...nav, rootPanel, activePanelId: leaf.id };
          }
        }

        // No existing settings tab — create one in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return { ...nav };

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const newTab = createTab("Settings", "local", dummyConfig, targetPanelId, "settings");
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          ...nav,
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content in the by-id map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openLogViewerTab: () =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing log-viewer tab
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find((t) => t.contentType === "log-viewer");
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        // No existing log-viewer tab — create one in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const newTab = createTab("Logs", "local", dummyConfig, targetPanelId, "log-viewer");
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content in the by-id map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openNetworkDiagnosticTab: (tool, prefillHost, connectionId) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const meta: NetworkDiagnosticMeta = { tool, prefillHost, connectionId };
        const dummyConfig: ConnectionConfig = { type: "local", config: {} };
        const toolLabel: Record<NetworkTool, string> = {
          "port-scanner": "Port Scanner",
          ping: "Ping",
          "ping-sweep": "Ping Sweep",
          "dns-lookup": "DNS Lookup",
          "http-monitor": "HTTP Monitor",
          traceroute: "Traceroute",
          wol: "Wake-on-LAN",
          "open-ports": "Open Ports",
        };
        const title = prefillHost ? `${toolLabel[tool]}: ${prefillHost}` : toolLabel[tool];
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "network-diagnostic");
        (
          newTab as TerminalTab & { networkDiagnosticMeta: NetworkDiagnosticMeta }
        ).networkDiagnosticMeta = meta;
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. its diagnostic meta) in the by-id
          // map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openTransferViewTab: (meta) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "transfer-view" &&
              t.transferViewMeta?.remoteTabId === meta.remoteTabId
          );
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;
        const remoteTitle = meta.remoteTabId
          ? state.tabContent[meta.remoteTabId]?.title
          : undefined;
        const title = remoteTitle ? `Transfer: ${remoteTitle}` : "File Transfer";
        const dummyConfig: ConnectionConfig = { type: "local", config: {} };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "transfer-view");
        newTab.transferViewMeta = meta;
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openEditorTab: (filePath, isRemote, permissions, sessionBrowser) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Stable identity of the backing session, so the same path opened from
        // two different remote sessions gets two tabs while a reconnect of the
        // same connection refreshes one (#1599).
        const sessionKey = resolveEditorSessionKey(state, isRemote, sessionBrowser);

        // Look for an existing editor tab for this file on the same session.
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "editor" &&
              t.editorMeta?.filePath === filePath &&
              t.editorMeta?.isRemote === isRemote &&
              t.editorMeta?.sessionKey === sessionKey
          );
          if (existing) {
            // Refresh the backing session so a reconnected session works.
            let refreshedMeta = existing.editorMeta;
            if (isRemote && existing.editorMeta && sessionBrowser) {
              refreshedMeta = {
                ...existing.editorMeta,
                sessionBrowser,
                sessionKey,
              };
            }
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) =>
                t.id === existing.id
                  ? { ...t, isActive: true, editorMeta: refreshedMeta }
                  : { ...t, isActive: false }
              ),
              activeTabId: existing.id,
            }));
            return {
              rootPanel,
              activePanelId: leaf.id,
              // Keep the mapped content in sync with the refreshed meta (#2283).
              tabContent: patchTabContentEntry(state.tabContent, existing.id, {
                editorMeta: refreshedMeta,
              }),
            };
          }
        }

        // Create new editor tab in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const fileName = filePath.split("/").pop() ?? filePath;
        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const editorMeta: EditorTabMeta = {
          filePath,
          isRemote,
          permissions,
          sessionBrowser,
          sessionKey,
        };
        const newTab = createTab(fileName, "local", dummyConfig, targetPanelId, "editor");
        newTab.editorMeta = editorMeta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. editorMeta) in the by-id map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openScratchEditorTab: (title, fileName, content) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const editorMeta: EditorTabMeta = {
          filePath: fileName,
          isRemote: false,
          scratch: true,
          scratchContent: content,
        };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "editor");
        newTab.editorMeta = editorMeta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the scratch editor's content (incl. editorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openConnectionEditorTab: (connectionId, folderId) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing connection-editor tab for this connection
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "connection-editor" &&
              t.connectionEditorMeta?.connectionId === connectionId
          );
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        // Create new connection-editor tab in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        // Determine tab title
        let title = "New Connection";
        if (connectionId === "new-remote-agent") {
          title = "New Remote Agent";
        } else if (connectionId !== "new") {
          const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
          if (conn) {
            title = `Edit: ${conn.name}`;
          }
        }

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const meta: ConnectionEditorMeta = {
          connectionId,
          folderId: folderId ?? null,
        };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "connection-editor");
        newTab.connectionEditorMeta = meta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. connectionEditorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openAgentDefinitionEditorTab: (agentId, definitionId, folderId) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing editor tab for this agent definition
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "connection-editor" &&
              t.connectionEditorMeta?.connectionId === agentId &&
              t.connectionEditorMeta?.agentDefinitionId === definitionId
          );
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        // Determine title
        let title = "New Agent Connection";
        if (definitionId !== "new") {
          const defs = currentAgentsView().agentDefinitions[agentId] ?? [];
          const def = defs.find((d) => d.id === definitionId);
          if (def) title = `Edit: ${def.name}`;
        }

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const meta: ConnectionEditorMeta = {
          connectionId: agentId,
          folderId: null,
          agentDefinitionId: definitionId,
          agentFolderId: folderId ?? null,
        };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "connection-editor");
        newTab.connectionEditorMeta = meta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. connectionEditorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    resolveAgentErrorTabs: (agentId) => {
      const defs = currentAgentsView().agentDefinitions[agentId] ?? [];

      const convertPanel = (panel: PanelNode): PanelNode => {
        if (panel.type === "split") {
          return { ...panel, children: panel.children.map(convertPanel) };
        }
        const updatedTabs = panel.tabs.map((tab) => {
          if (tab.contentType !== "agent-error" || tab.agentErrorMeta?.agentId !== agentId) {
            return tab;
          }
          const def = defs.find((d) => d.id === tab.agentErrorMeta!.definitionId);
          if (!def) return tab; // definition still missing — keep error tab
          const config: ConnectionConfig = {
            type: "remote-session",
            config: {
              agentId,
              sessionType: def.sessionType,
              shell: def.config["shell"] as string | undefined,
              serialPort: def.config["port"] as string | undefined,
              persistent: def.persistent,
              title: def.name,
            },
          };
          return {
            ...tab,
            contentType: "terminal" as const,
            connectionType: "remote-session" as const,
            config,
            sessionId: null,
            agentErrorMeta: undefined,
            initialCommand: tab.agentErrorMeta!.initialCommand,
          };
        });
        return { ...panel, tabs: updatedTabs };
      };

      setAndReseed((s) => {
        const rootPanel = convertPanel(s.rootPanel);
        const tabGroups = s.tabGroups.map((g) => ({ ...g, rootPanel: convertPanel(g.rootPanel) }));
        return {
          rootPanel,
          tabGroups,
          // Instrument the agent-error → terminal conversion so the by-id content
          // map never goes stale (#2539): re-track every tab from the converted
          // trees, so a resolved tab now resolves as a `terminal` from `tabContent`.
          tabContent: tabContentFromGroups(tabGroups, s.activeTabGroupId, rootPanel),
        };
      });
    },

    openTunnelEditorTab: (tunnelId, options) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        // A new tunnel pre-bound to a connection (PROD-023) is only the "same"
        // editor as an open new-tunnel tab pre-bound to that same connection.
        const prefillConnectionId = tunnelId === null ? options?.sshConnectionId : undefined;

        // Look for an existing tunnel-editor tab for this tunnel
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "tunnel-editor" &&
              t.tunnelEditorMeta?.tunnelId === tunnelId &&
              t.tunnelEditorMeta?.sshConnectionId === prefillConnectionId
          );
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        // Create new tunnel-editor tab in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        let title = "New Tunnel";
        if (tunnelId) {
          const tunnel = state.tunnels.find((t) => t.id === tunnelId);
          if (tunnel) {
            title = `Edit: ${tunnel.name}`;
          }
        }

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const meta: TunnelEditorMeta = prefillConnectionId
          ? { tunnelId, sshConnectionId: prefillConnectionId }
          : { tunnelId };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "tunnel-editor");
        newTab.tunnelEditorMeta = meta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. tunnelEditorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    selectPlugin: (pluginId) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const plugin = state.plugins.find((p) => p.manifest.id === pluginId);
        const title = plugin ? plugin.manifest.name : "Plugin";

        // Reuse the single existing plugin-detail tab: re-point its meta/title at
        // the newly-selected plugin and activate it, rather than opening one tab
        // per plugin (matches Settings/Log-Viewer single-tab behaviour).
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find((t) => t.contentType === "plugin-detail");
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) =>
                t.id === existing.id
                  ? { ...t, title, isActive: true, pluginDetailMeta: { pluginId } }
                  : { ...t, isActive: false }
              ),
              activeTabId: existing.id,
            }));
            return {
              rootPanel,
              activePanelId: leaf.id,
              selectedPluginId: pluginId,
              // Keep the mapped content in sync with the re-pointed title/meta (#2283).
              tabContent: patchTabContentEntry(state.tabContent, existing.id, {
                title,
                pluginDetailMeta: { pluginId },
              }),
            };
          }
        }

        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return { selectedPluginId: pluginId };

        const dummyConfig: ConnectionConfig = { type: "local", config: {} };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "plugin-detail");
        (newTab as TerminalTab & { pluginDetailMeta: PluginDetailMeta }).pluginDetailMeta = {
          pluginId,
        };
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          selectedPluginId: pluginId,
          // Track the new tab's content (incl. pluginDetailMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openWorkspaceEditorTab: (workspaceId) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing workspace-editor tab for this workspace
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "workspace-editor" &&
              t.workspaceEditorMeta?.workspaceId === workspaceId
          );
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        // Create new workspace-editor tab in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        let title = "New Workspace";
        if (workspaceId) {
          const ws = state.workspaces.find((w) => w.id === workspaceId);
          if (ws) {
            title = `Edit: ${ws.name}`;
          }
        }

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const meta: WorkspaceEditorMeta = { workspaceId };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "workspace-editor");
        newTab.workspaceEditorMeta = meta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. workspaceEditorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),
  };
};
