import { create } from "zustand";
import { TerminalTab, LeafPanel, PanelNode, ConnectionType, ConnectionConfig, SshConfig, DropEdge, TabContentType, TerminalOptions } from "@/types/terminal";
import { SavedConnection, ConnectionFolder, FileEntry } from "@/types/connection";
import {
  loadConnections,
  persistConnection,
  removeConnection,
  persistFolder,
  removeFolder,
} from "@/services/storage";
import { sftpOpen, sftpClose, sftpListDir, localListDir } from "@/services/api";
import {
  createLeafPanel,
  findLeaf,
  getAllLeaves,
  updateLeaf,
  removeLeaf,
  splitLeaf,
  simplifyTree,
  edgeToSplit,
} from "@/utils/panelTree";

export type SidebarView = "connections" | "files";

/**
 * Strip password from an SSH connection config so it is never persisted.
 */
function stripSshPassword(connection: SavedConnection): SavedConnection {
  if (connection.config.type === "ssh" && connection.config.config.password) {
    return {
      ...connection,
      config: {
        ...connection.config,
        config: { ...connection.config.config, password: undefined },
      },
    };
  }
  return connection;
}

interface AppState {
  // Sidebar
  sidebarView: SidebarView;
  sidebarCollapsed: boolean;
  setSidebarView: (view: SidebarView) => void;
  toggleSidebar: () => void;

  // Password prompt
  passwordPromptOpen: boolean;
  passwordPromptHost: string;
  passwordPromptUsername: string;
  passwordPromptResolve: ((password: string | null) => void) | null;
  requestPassword: (host: string, username: string) => Promise<string | null>;
  submitPassword: (password: string) => void;
  dismissPasswordPrompt: () => void;

  // Panels & Tabs
  rootPanel: PanelNode;
  activePanelId: string | null;
  addTab: (title: string, connectionType: ConnectionType, config?: ConnectionConfig, panelId?: string, contentType?: TabContentType, terminalOptions?: TerminalOptions) => void;
  openSettingsTab: () => void;
  closeTab: (tabId: string, panelId: string) => void;
  setActiveTab: (tabId: string, panelId: string) => void;
  moveTab: (tabId: string, fromPanelId: string, toPanelId: string, newIndex: number) => void;
  reorderTabs: (panelId: string, oldIndex: number, newIndex: number) => void;
  splitPanel: (direction?: "horizontal" | "vertical") => void;
  removePanel: (panelId: string) => void;
  setActivePanel: (panelId: string) => void;
  splitPanelWithTab: (tabId: string, fromPanelId: string, targetPanelId: string, edge: DropEdge) => void;
  getAllPanels: () => LeafPanel[];

  // Connections
  folders: ConnectionFolder[];
  connections: SavedConnection[];
  editingConnectionId: string | null;
  editingConnectionFolderId: string | null;
  loadFromBackend: () => Promise<void>;
  toggleFolder: (folderId: string) => void;
  addConnection: (connection: SavedConnection) => void;
  updateConnection: (connection: SavedConnection) => void;
  deleteConnection: (connectionId: string) => void;
  setEditingConnection: (connectionId: string | null, folderId?: string | null) => void;
  addFolder: (folder: ConnectionFolder) => void;
  deleteFolder: (folderId: string) => void;
  duplicateConnection: (connectionId: string) => void;
  moveConnectionToFolder: (connectionId: string, folderId: string | null) => void;

  // File browser / SFTP
  fileEntries: FileEntry[];
  currentPath: string;
  sftpSessionId: string | null;
  sftpLoading: boolean;
  sftpError: string | null;
  sftpConnectedHost: string | null;
  setCurrentPath: (path: string) => void;
  setFileEntries: (entries: FileEntry[]) => void;
  connectSftp: (config: SshConfig) => Promise<void>;
  disconnectSftp: () => Promise<void>;
  navigateSftp: (path: string) => Promise<void>;
  refreshSftp: () => Promise<void>;

  // Per-tab CWD tracking
  tabCwds: Record<string, string>;
  setTabCwd: (tabId: string, cwd: string) => void;

  // Per-tab horizontal scrolling
  tabHorizontalScrolling: Record<string, boolean>;
  setTabHorizontalScrolling: (tabId: string, enabled: boolean) => void;

  // Local file browser state
  localFileEntries: FileEntry[];
  localCurrentPath: string;
  localFileLoading: boolean;
  localFileError: string | null;
  navigateLocal: (path: string) => Promise<void>;
  refreshLocal: () => Promise<void>;

  // File browser mode
  fileBrowserMode: "local" | "sftp" | "none";
  setFileBrowserMode: (mode: "local" | "sftp" | "none") => void;
}

let tabCounter = 0;

function createTab(title: string, connectionType: ConnectionType, config: ConnectionConfig, panelId: string, contentType: TabContentType = "terminal"): TerminalTab {
  tabCounter++;
  return {
    id: `tab-${tabCounter}`,
    sessionId: null,
    title,
    connectionType,
    contentType,
    config,
    panelId,
    isActive: true,
  };
}

/**
 * Remove a tab from a leaf panel, choosing a new active tab if needed.
 * Returns the updated leaf (may have empty tabs).
 */
function removeTabFromLeaf(leaf: LeafPanel, tabId: string): LeafPanel {
  const idx = leaf.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return leaf;

  const tabs = leaf.tabs.filter((t) => t.id !== tabId);
  let activeTabId = leaf.activeTabId;
  if (activeTabId === tabId) {
    const newIdx = Math.min(idx, tabs.length - 1);
    activeTabId = tabs[newIdx]?.id ?? null;
  }
  if (activeTabId) {
    return {
      ...leaf,
      tabs: tabs.map((t) => ({ ...t, isActive: t.id === activeTabId })),
      activeTabId,
    };
  }
  return { ...leaf, tabs, activeTabId: null };
}

export const useAppStore = create<AppState>((set, get) => {
  const initialPanel = createLeafPanel();

  return {
    // Sidebar
    sidebarView: "connections",
    sidebarCollapsed: false,
    setSidebarView: (view) =>
      set((state) => ({
        sidebarView: view,
        sidebarCollapsed: state.sidebarView === view && !state.sidebarCollapsed
          ? true
          : false,
      })),
    toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

    // Password prompt
    passwordPromptOpen: false,
    passwordPromptHost: "",
    passwordPromptUsername: "",
    passwordPromptResolve: null,

    requestPassword: (host, username) => {
      return new Promise<string | null>((resolve) => {
        set({
          passwordPromptOpen: true,
          passwordPromptHost: host,
          passwordPromptUsername: username,
          passwordPromptResolve: resolve,
        });
      });
    },

    submitPassword: (password) => {
      const { passwordPromptResolve } = get();
      if (passwordPromptResolve) passwordPromptResolve(password);
      set({
        passwordPromptOpen: false,
        passwordPromptHost: "",
        passwordPromptUsername: "",
        passwordPromptResolve: null,
      });
    },

    dismissPasswordPrompt: () => {
      const { passwordPromptResolve } = get();
      if (passwordPromptResolve) passwordPromptResolve(null);
      set({
        passwordPromptOpen: false,
        passwordPromptHost: "",
        passwordPromptUsername: "",
        passwordPromptResolve: null,
      });
    },

    // Panels & Tabs
    rootPanel: initialPanel,
    activePanelId: initialPanel.id,

    getAllPanels: () => getAllLeaves(get().rootPanel),

    addTab: (title, connectionType, config, panelId, contentType, terminalOptions) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const targetPanelId = panelId ?? state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const defaultConfig: ConnectionConfig = config ?? { type: "local", config: { shellType: "zsh" } };
        const newTab = createTab(title, connectionType, defaultConfig, targetPanelId, contentType);
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        const hsEnabled = terminalOptions?.horizontalScrolling ?? false;
        return {
          rootPanel,
          activePanelId: targetPanelId,
          tabHorizontalScrolling: { ...state.tabHorizontalScrolling, [newTab.id]: hsEnabled },
        };
      }),

    openSettingsTab: () =>
      set((state) => {
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
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        // No existing settings tab — create one in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const dummyConfig: ConnectionConfig = { type: "local", config: { shellType: "zsh" } };
        const newTab = createTab("Settings", "local", dummyConfig, targetPanelId, "settings");
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return { rootPanel, activePanelId: targetPanelId };
      }),

    closeTab: (tabId, panelId) =>
      set((state) => {
        // Clean up per-tab state for the closed tab
        const { [tabId]: _removed, ...remainingCwds } = state.tabCwds;
        const { [tabId]: _removedHs, ...remainingHs } = state.tabHorizontalScrolling;

        let rootPanel = updateLeaf(state.rootPanel, panelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // If leaf is now empty and not the sole leaf, remove it
        const allLeaves = getAllLeaves(rootPanel);
        const updatedLeaf = findLeaf(rootPanel, panelId);
        if (updatedLeaf && updatedLeaf.tabs.length === 0 && allLeaves.length > 1) {
          const removed = removeLeaf(rootPanel, panelId);
          rootPanel = removed ? simplifyTree(removed) : rootPanel;
          const newLeaves = getAllLeaves(rootPanel);
          const activePanelId = state.activePanelId === panelId
            ? newLeaves[0]?.id ?? null
            : state.activePanelId;
          return { rootPanel, activePanelId, tabCwds: remainingCwds, tabHorizontalScrolling: remainingHs };
        }

        return { rootPanel, tabCwds: remainingCwds, tabHorizontalScrolling: remainingHs };
      }),

    setActiveTab: (tabId, panelId) =>
      set((state) => ({
        rootPanel: updateLeaf(state.rootPanel, panelId, (leaf) => ({
          ...leaf,
          tabs: leaf.tabs.map((t) => ({ ...t, isActive: t.id === tabId })),
          activeTabId: tabId,
        })),
        activePanelId: panelId,
      })),

    moveTab: (tabId, fromPanelId, toPanelId, newIndex) =>
      set((state) => {
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
      }),

    reorderTabs: (panelId, oldIndex, newIndex) =>
      set((state) => ({
        rootPanel: updateLeaf(state.rootPanel, panelId, (leaf) => {
          const tabs = [...leaf.tabs];
          const [moved] = tabs.splice(oldIndex, 1);
          tabs.splice(newIndex, 0, moved);
          return { ...leaf, tabs };
        }),
      })),

    splitPanel: (direction) =>
      set((state) => {
        const dir = direction ?? "horizontal";
        const targetId = state.activePanelId;
        if (!targetId) return state;

        const newLeaf = createLeafPanel();
        let rootPanel = splitLeaf(state.rootPanel, targetId, newLeaf, dir, "after");
        rootPanel = simplifyTree(rootPanel);
        return { rootPanel, activePanelId: newLeaf.id };
      }),

    removePanel: (panelId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        if (allLeaves.length <= 1) return state;

        const removed = removeLeaf(state.rootPanel, panelId);
        if (!removed) return state;
        const rootPanel = simplifyTree(removed);
        const newLeaves = getAllLeaves(rootPanel);
        const activePanelId = state.activePanelId === panelId
          ? newLeaves[0]?.id ?? null
          : state.activePanelId;
        return { rootPanel, activePanelId };
      }),

    setActivePanel: (panelId) => set({ activePanelId: panelId }),

    splitPanelWithTab: (tabId, fromPanelId, targetPanelId, edge) =>
      set((state) => {
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
      }),

    // Connections — initialized empty, loaded from backend on mount
    folders: [],
    connections: [],
    editingConnectionId: null,
    editingConnectionFolderId: null,

    loadFromBackend: async () => {
      try {
        const { connections, folders } = await loadConnections();
        set({ connections, folders });
      } catch (err) {
        console.error("Failed to load connections from backend:", err);
      }
    },

    toggleFolder: (folderId) => {
      set((state) => {
        const folders = state.folders.map((f) =>
          f.id === folderId ? { ...f, isExpanded: !f.isExpanded } : f
        );
        // Persist the toggled folder
        const toggled = folders.find((f) => f.id === folderId);
        if (toggled) {
          persistFolder(toggled).catch((err) =>
            console.error("Failed to persist folder toggle:", err)
          );
        }
        return { folders };
      });
    },

    addConnection: (connection) => {
      set((state) => ({ connections: [...state.connections, connection] }));
      persistConnection(stripSshPassword(connection)).catch((err) =>
        console.error("Failed to persist new connection:", err)
      );
    },

    updateConnection: (connection) => {
      set((state) => ({
        connections: state.connections.map((c) =>
          c.id === connection.id ? connection : c
        ),
      }));
      persistConnection(stripSshPassword(connection)).catch((err) =>
        console.error("Failed to persist connection update:", err)
      );
    },

    deleteConnection: (connectionId) => {
      set((state) => ({
        connections: state.connections.filter((c) => c.id !== connectionId),
      }));
      removeConnection(connectionId).catch((err) =>
        console.error("Failed to persist connection deletion:", err)
      );
    },

    setEditingConnection: (connectionId, folderId) =>
      set({ editingConnectionId: connectionId, editingConnectionFolderId: folderId ?? null }),

    addFolder: (folder) => {
      set((state) => ({ folders: [...state.folders, folder] }));
      persistFolder(folder).catch((err) =>
        console.error("Failed to persist new folder:", err)
      );
    },

    deleteFolder: (folderId) => {
      set((state) => {
        // Move child connections to root
        const connections = state.connections.map((c) =>
          c.folderId === folderId ? { ...c, folderId: null } : c
        );
        // Reparent child folders
        const deletedFolder = state.folders.find((f) => f.id === folderId);
        const parentId = deletedFolder?.parentId ?? null;
        const folders = state.folders
          .map((f) => (f.parentId === folderId ? { ...f, parentId } : f))
          .filter((f) => f.id !== folderId);

        // Persist moved connections
        connections
          .filter((c) => c.folderId === null && state.connections.find((sc) => sc.id === c.id)?.folderId === folderId)
          .forEach((c) => {
            persistConnection(c).catch((err) =>
              console.error("Failed to persist connection move:", err)
            );
          });

        return { folders, connections };
      });
      removeFolder(folderId).catch((err) =>
        console.error("Failed to persist folder deletion:", err)
      );
    },

    duplicateConnection: (connectionId) => {
      const state = useAppStore.getState();
      const original = state.connections.find((c) => c.id === connectionId);
      if (!original) return;
      const duplicate: SavedConnection = {
        ...original,
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Copy of ${original.name}`,
      };
      set((s) => ({ connections: [...s.connections, duplicate] }));
      persistConnection(stripSshPassword(duplicate)).catch((err) =>
        console.error("Failed to persist duplicated connection:", err)
      );
    },

    moveConnectionToFolder: (connectionId, folderId) => {
      set((state) => {
        const connections = state.connections.map((c) =>
          c.id === connectionId ? { ...c, folderId } : c
        );
        const moved = connections.find((c) => c.id === connectionId);
        if (moved) {
          persistConnection(moved).catch((err) =>
            console.error("Failed to persist connection move:", err)
          );
        }
        return { connections };
      });
    },

    // File browser / SFTP
    fileEntries: [],
    currentPath: "/",
    sftpSessionId: null,
    sftpLoading: false,
    sftpError: null,
    sftpConnectedHost: null,

    setCurrentPath: (path) => set({ currentPath: path }),
    setFileEntries: (entries) => set({ fileEntries: entries }),

    connectSftp: async (config: SshConfig) => {
      set({ sftpLoading: true, sftpError: null });
      try {
        const sessionId = await sftpOpen(config);
        const homePath = `/home/${config.username}`;
        let entries: FileEntry[];
        let activePath = homePath;
        try {
          entries = await sftpListDir(sessionId, homePath);
        } catch {
          // Fall back to root if home dir doesn't exist
          activePath = "/";
          entries = await sftpListDir(sessionId, "/");
        }
        set({
          sftpSessionId: sessionId,
          sftpLoading: false,
          currentPath: activePath,
          fileEntries: entries,
          sftpConnectedHost: `${config.username}@${config.host}:${config.port}`,
        });
      } catch (err) {
        set({
          sftpLoading: false,
          sftpError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    disconnectSftp: async () => {
      const sessionId = useAppStore.getState().sftpSessionId;
      if (sessionId) {
        try {
          await sftpClose(sessionId);
        } catch {
          // Ignore close errors
        }
      }
      set({
        sftpSessionId: null,
        fileEntries: [],
        currentPath: "/",
        sftpError: null,
        sftpConnectedHost: null,
      });
    },

    navigateSftp: async (path: string) => {
      const sessionId = useAppStore.getState().sftpSessionId;
      if (!sessionId) return;
      set({ sftpLoading: true, sftpError: null });
      try {
        const entries = await sftpListDir(sessionId, path);
        set({ fileEntries: entries, currentPath: path, sftpLoading: false });
      } catch (err) {
        set({
          sftpLoading: false,
          sftpError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshSftp: async () => {
      const { sftpSessionId, currentPath } = useAppStore.getState();
      if (!sftpSessionId) return;
      set({ sftpLoading: true, sftpError: null });
      try {
        const entries = await sftpListDir(sftpSessionId, currentPath);
        set({ fileEntries: entries, sftpLoading: false });
      } catch (err) {
        set({
          sftpLoading: false,
          sftpError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    // Per-tab CWD tracking
    tabCwds: {},
    setTabCwd: (tabId, cwd) =>
      set((state) => ({ tabCwds: { ...state.tabCwds, [tabId]: cwd } })),

    // Per-tab horizontal scrolling
    tabHorizontalScrolling: {},
    setTabHorizontalScrolling: (tabId, enabled) =>
      set((state) => ({ tabHorizontalScrolling: { ...state.tabHorizontalScrolling, [tabId]: enabled } })),

    // Local file browser state
    localFileEntries: [],
    localCurrentPath: "/",
    localFileLoading: false,
    localFileError: null,

    navigateLocal: async (path: string) => {
      set({ localFileLoading: true, localFileError: null });
      try {
        const entries = await localListDir(path);
        set({ localFileEntries: entries, localCurrentPath: path, localFileLoading: false });
      } catch (err) {
        set({
          localFileLoading: false,
          localFileError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshLocal: async () => {
      const { localCurrentPath } = useAppStore.getState();
      set({ localFileLoading: true, localFileError: null });
      try {
        const entries = await localListDir(localCurrentPath);
        set({ localFileEntries: entries, localFileLoading: false });
      } catch (err) {
        set({
          localFileLoading: false,
          localFileError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    // File browser mode
    fileBrowserMode: "none",
    setFileBrowserMode: (mode) => set({ fileBrowserMode: mode }),
  };
});

/**
 * Get the active tab from the current store state.
 */
export function getActiveTab(state: AppState): TerminalTab | null {
  const { activePanelId, rootPanel } = state;
  if (!activePanelId) return null;
  const leaf = findLeaf(rootPanel, activePanelId);
  if (!leaf || !leaf.activeTabId) return null;
  return leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? null;
}
