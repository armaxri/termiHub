import { create } from "zustand";
import { TerminalTab, SplitPanel, ConnectionType, ConnectionConfig, SshConfig } from "@/types/terminal";
import { SavedConnection, ConnectionFolder, FileEntry } from "@/types/connection";
import {
  loadConnections,
  persistConnection,
  removeConnection,
  persistFolder,
  removeFolder,
} from "@/services/storage";
import { sftpOpen, sftpClose, sftpListDir } from "@/services/api";

export type SidebarView = "connections" | "files" | "settings";

interface AppState {
  // Sidebar
  sidebarView: SidebarView;
  sidebarCollapsed: boolean;
  setSidebarView: (view: SidebarView) => void;
  toggleSidebar: () => void;

  // Panels & Tabs
  panels: SplitPanel[];
  activePanelId: string | null;
  addTab: (title: string, connectionType: ConnectionType, config?: ConnectionConfig, panelId?: string) => void;
  closeTab: (tabId: string, panelId: string) => void;
  setActiveTab: (tabId: string, panelId: string) => void;
  moveTab: (tabId: string, fromPanelId: string, toPanelId: string, newIndex: number) => void;
  reorderTabs: (panelId: string, oldIndex: number, newIndex: number) => void;
  splitPanel: () => void;
  removePanel: (panelId: string) => void;
  setActivePanel: (panelId: string) => void;

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
  setCurrentPath: (path: string) => void;
  setFileEntries: (entries: FileEntry[]) => void;
  connectSftp: (config: SshConfig) => Promise<void>;
  disconnectSftp: () => Promise<void>;
  navigateSftp: (path: string) => Promise<void>;
  refreshSftp: () => Promise<void>;
}

let tabCounter = 0;

function createTab(title: string, connectionType: ConnectionType, config: ConnectionConfig, panelId: string): TerminalTab {
  tabCounter++;
  return {
    id: `tab-${tabCounter}`,
    sessionId: null,
    title,
    connectionType,
    config,
    panelId,
    isActive: true,
  };
}

function createPanel(): SplitPanel {
  const id = `panel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return { id, tabs: [], activeTabId: null };
}

export const useAppStore = create<AppState>((set) => {
  const initialPanel = createPanel();

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

    // Panels & Tabs
    panels: [initialPanel],
    activePanelId: initialPanel.id,

    addTab: (title, connectionType, config, panelId) =>
      set((state) => {
        const targetPanelId = panelId ?? state.activePanelId ?? state.panels[0]?.id;
        if (!targetPanelId) return state;

        const defaultConfig: ConnectionConfig = config ?? { type: "local", config: { shellType: "zsh" } };
        const newTab = createTab(title, connectionType, defaultConfig, targetPanelId);
        const panels = state.panels.map((panel) => {
          if (panel.id !== targetPanelId) return panel;
          const tabs = panel.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...panel, tabs, activeTabId: newTab.id };
        });
        return { panels, activePanelId: targetPanelId };
      }),

    closeTab: (tabId, panelId) =>
      set((state) => {
        const panels = state.panels.map((panel) => {
          if (panel.id !== panelId) return panel;
          const idx = panel.tabs.findIndex((t) => t.id === tabId);
          if (idx === -1) return panel;

          const tabs = panel.tabs.filter((t) => t.id !== tabId);
          let activeTabId = panel.activeTabId;
          if (activeTabId === tabId) {
            const newIdx = Math.min(idx, tabs.length - 1);
            activeTabId = tabs[newIdx]?.id ?? null;
          }
          if (activeTabId) {
            return {
              ...panel,
              tabs: tabs.map((t) => ({ ...t, isActive: t.id === activeTabId })),
              activeTabId,
            };
          }
          return { ...panel, tabs, activeTabId: null };
        });
        return { panels };
      }),

    setActiveTab: (tabId, panelId) =>
      set((state) => ({
        panels: state.panels.map((panel) => {
          if (panel.id !== panelId) return panel;
          return {
            ...panel,
            tabs: panel.tabs.map((t) => ({ ...t, isActive: t.id === tabId })),
            activeTabId: tabId,
          };
        }),
        activePanelId: panelId,
      })),

    moveTab: (tabId, fromPanelId, toPanelId, newIndex) =>
      set((state) => {
        let movedTab: TerminalTab | null = null;
        let panels = state.panels.map((panel) => {
          if (panel.id !== fromPanelId) return panel;
          const tab = panel.tabs.find((t) => t.id === tabId);
          if (!tab) return panel;
          movedTab = { ...tab, panelId: toPanelId };
          const tabs = panel.tabs.filter((t) => t.id !== tabId);
          const activeTabId = panel.activeTabId === tabId
            ? (tabs[0]?.id ?? null)
            : panel.activeTabId;
          return { ...panel, tabs, activeTabId };
        });
        if (!movedTab) return state;
        panels = panels.map((panel) => {
          if (panel.id !== toPanelId) return panel;
          const tabs = [...panel.tabs];
          tabs.splice(newIndex, 0, movedTab!);
          return {
            ...panel,
            tabs: tabs.map((t) => ({ ...t, isActive: t.id === movedTab!.id })),
            activeTabId: movedTab!.id,
          };
        });
        return { panels, activePanelId: toPanelId };
      }),

    reorderTabs: (panelId, oldIndex, newIndex) =>
      set((state) => ({
        panels: state.panels.map((panel) => {
          if (panel.id !== panelId) return panel;
          const tabs = [...panel.tabs];
          const [moved] = tabs.splice(oldIndex, 1);
          tabs.splice(newIndex, 0, moved);
          return { ...panel, tabs };
        }),
      })),

    splitPanel: () =>
      set((state) => {
        const newPanel = createPanel();
        return {
          panels: [...state.panels, newPanel],
          activePanelId: newPanel.id,
        };
      }),

    removePanel: (panelId) =>
      set((state) => {
        if (state.panels.length <= 1) return state;
        const panels = state.panels.filter((p) => p.id !== panelId);
        const activePanelId = state.activePanelId === panelId
          ? panels[0]?.id ?? null
          : state.activePanelId;
        return { panels, activePanelId };
      }),

    setActivePanel: (panelId) => set({ activePanelId: panelId }),

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
      persistConnection(connection).catch((err) =>
        console.error("Failed to persist new connection:", err)
      );
    },

    updateConnection: (connection) => {
      set((state) => ({
        connections: state.connections.map((c) =>
          c.id === connection.id ? connection : c
        ),
      }));
      persistConnection(connection).catch((err) =>
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
      persistConnection(duplicate).catch((err) =>
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
  };
});
