import { create } from "zustand";
import { TerminalTab, SplitPanel, ConnectionType } from "@/types/terminal";
import { SavedConnection, ConnectionFolder, FileEntry } from "@/types/connection";
import { MOCK_FOLDERS, MOCK_CONNECTIONS, MOCK_FILES } from "./mockData";

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
  addTab: (title: string, connectionType: ConnectionType, panelId?: string) => void;
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
  toggleFolder: (folderId: string) => void;
  addConnection: (connection: SavedConnection) => void;
  updateConnection: (connection: SavedConnection) => void;
  deleteConnection: (connectionId: string) => void;
  setEditingConnection: (connectionId: string | null) => void;
  addFolder: (folder: ConnectionFolder) => void;

  // File browser
  fileEntries: FileEntry[];
  currentPath: string;
  setCurrentPath: (path: string) => void;
  setFileEntries: (entries: FileEntry[]) => void;
}

let tabCounter = 0;

function createTab(title: string, connectionType: ConnectionType, panelId: string): TerminalTab {
  tabCounter++;
  return {
    id: `tab-${tabCounter}`,
    sessionId: null,
    title,
    connectionType,
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

    addTab: (title, connectionType, panelId) =>
      set((state) => {
        const targetPanelId = panelId ?? state.activePanelId ?? state.panels[0]?.id;
        if (!targetPanelId) return state;

        const newTab = createTab(title, connectionType, targetPanelId);
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

    // Connections
    folders: MOCK_FOLDERS,
    connections: MOCK_CONNECTIONS,
    editingConnectionId: null,

    toggleFolder: (folderId) =>
      set((state) => ({
        folders: state.folders.map((f) =>
          f.id === folderId ? { ...f, isExpanded: !f.isExpanded } : f
        ),
      })),

    addConnection: (connection) =>
      set((state) => ({ connections: [...state.connections, connection] })),

    updateConnection: (connection) =>
      set((state) => ({
        connections: state.connections.map((c) =>
          c.id === connection.id ? connection : c
        ),
      })),

    deleteConnection: (connectionId) =>
      set((state) => ({
        connections: state.connections.filter((c) => c.id !== connectionId),
      })),

    setEditingConnection: (connectionId) =>
      set({ editingConnectionId: connectionId }),

    addFolder: (folder) =>
      set((state) => ({ folders: [...state.folders, folder] })),

    // File browser
    fileEntries: MOCK_FILES,
    currentPath: "/home/pi",

    setCurrentPath: (path) => set({ currentPath: path }),
    setFileEntries: (entries) => set({ fileEntries: entries }),
  };
});
