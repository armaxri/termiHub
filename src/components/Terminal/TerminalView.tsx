import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Plus,
  Columns2,
  Rows2,
  X,
  PanelLeft,
  Settings as SettingsIcon,
  FileEdit,
  SquarePen,
  ScrollText,
  ArrowLeftRight,
  LayoutGrid,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { getAllLeaves, findLeafByTab } from "@/utils/panelTree";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { TerminalCommandBridge } from "./TerminalCommandBridge";
import { Terminal } from "./Terminal";
import { SplitView } from "@/components/SplitView";
import { TabGroupStrip } from "@/components/TabGroupStrip/TabGroupStrip";
import { terminalDispatcher } from "@/services/events";
import "./TerminalView.css";

export function TerminalView() {
  useEffect(() => {
    terminalDispatcher.init();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ session_id: string; state: string }>("remote-state-change", (event) => {
      const { session_id, state } = event.payload;
      useAppStore.getState().setRemoteState(session_id, state);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ session_id: string; state: string }>("agent-state-change", (event) => {
      const { session_id, state } = event.payload;
      const store = useAppStore.getState();
      store.setAgentConnectionState(
        session_id,
        state as "disconnected" | "connecting" | "connected" | "reconnecting"
      );
      if (state === "connected") {
        store.refreshAgentSessions(session_id);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const addTab = useAppStore((s) => s.addTab);
  const splitPanel = useAppStore((s) => s.splitPanel);
  const rootPanel = useAppStore((s) => s.rootPanel);
  const activePanelId = useAppStore((s) => s.activePanelId);
  const removePanel = useAppStore((s) => s.removePanel);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const moveTab = useAppStore((s) => s.moveTab);
  const splitPanelWithTab = useAppStore((s) => s.splitPanelWithTab);
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup);

  const [activeDragTab, setActiveDragTab] = useState<TerminalTab | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const tabId = event.active.id as string;
      const leaf = findLeafByTab(rootPanel, tabId);
      if (!leaf) return;
      const tab = leaf.tabs.find((t) => t.id === tabId);
      if (tab) setActiveDragTab(tab);
    },
    [rootPanel]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragTab(null);
      const { active, over } = event;
      if (!over) return;

      const tabId = active.id as string;
      const overId = over.id as string;
      const fromPanelId = (active.data.current as { panelId?: string })?.panelId;
      if (!fromPanelId) return;

      // Cross-group drop: tab dropped onto a tab group chip
      if (overId.startsWith("tgchip-")) {
        const toGroupId = overId.slice("tgchip-".length);
        moveTabToGroup(tabId, fromPanelId, toGroupId);
        return;
      }

      // Edge drop: split panel with tab
      if (overId.startsWith("edge-")) {
        const parts = overId.split("-");
        const edge = parts[parts.length - 1] as import("@/types/terminal").DropEdge;
        const targetPanelId = parts.slice(1, -1).join("-");
        splitPanelWithTab(tabId, fromPanelId, targetPanelId, edge);
        return;
      }

      // Center drop: move tab to that panel
      if (overId.startsWith("center-")) {
        const targetPanelId = overId.slice("center-".length);
        if (targetPanelId === fromPanelId) return;
        splitPanelWithTab(tabId, fromPanelId, targetPanelId, "center");
        return;
      }

      // Sortable tab drop — find which panel the over tab belongs to
      const overData = over.data.current as { panelId?: string; type?: string } | undefined;
      const overPanelId = overData?.panelId;

      if (overPanelId && overPanelId !== fromPanelId) {
        const destLeaf = getAllLeaves(rootPanel).find((l) => l.id === overPanelId);
        if (!destLeaf) return;
        const overIndex = destLeaf.tabs.findIndex((t) => t.id === overId);
        moveTab(tabId, fromPanelId, overPanelId, overIndex >= 0 ? overIndex : -1);
        return;
      }

      // Same-panel reorder
      if (tabId === overId) return;
      const sourceLeaf = getAllLeaves(rootPanel).find((l) => l.id === fromPanelId);
      if (!sourceLeaf) return;
      const oldIndex = sourceLeaf.tabs.findIndex((t) => t.id === tabId);
      const newIndex = sourceLeaf.tabs.findIndex((t) => t.id === overId);
      if (oldIndex !== -1 && newIndex !== -1) {
        reorderTabs(fromPanelId, oldIndex, newIndex);
      }
    },
    [rootPanel, reorderTabs, moveTab, splitPanelWithTab, moveTabToGroup]
  );

  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const sidebarToggleTitle = `Toggle Sidebar (${isMac ? "Cmd" : "Ctrl"}+B)`;

  const allLeaves = getAllLeaves(rootPanel);

  return (
    <TerminalPortalProvider>
      <TerminalCommandBridge />
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="terminal-view">
          <div className="terminal-view__toolbar">
            <div className="terminal-view__toolbar-actions">
              <button
                className="terminal-view__toolbar-btn"
                onClick={() => addTab("Terminal", "local")}
                title="New Terminal"
                data-testid="terminal-view-new-terminal"
              >
                <Plus size={16} />
              </button>
              <button
                className="terminal-view__toolbar-btn"
                onClick={() => splitPanel("horizontal")}
                title="Split Terminal Right"
                data-testid="terminal-view-split-horizontal"
              >
                <Columns2 size={16} />
              </button>
              <button
                className="terminal-view__toolbar-btn"
                onClick={() => splitPanel("vertical")}
                title="Split Terminal Down"
                data-testid="terminal-view-split-vertical"
              >
                <Rows2 size={16} />
              </button>
              {allLeaves.length > 1 && (
                <button
                  className="terminal-view__toolbar-btn"
                  onClick={() => {
                    if (activePanelId && allLeaves.length > 1) removePanel(activePanelId);
                  }}
                  title="Close Panel"
                  data-testid="terminal-view-close-panel"
                >
                  <X size={16} />
                </button>
              )}
              <button
                className={`terminal-view__toolbar-btn${!sidebarCollapsed ? " terminal-view__toolbar-btn--active" : ""}`}
                onClick={toggleSidebar}
                title={sidebarToggleTitle}
                data-testid="terminal-view-toggle-sidebar"
              >
                <PanelLeft size={16} />
              </button>
            </div>
          </div>
          <div className="terminal-view__workspace">
            <TabGroupStrip activeDragTabId={activeDragTab?.id ?? null} />
            <div className="terminal-view__content">
              <TerminalHost />
              <SplitView activeDragTab={activeDragTab} />
            </div>
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {activeDragTab && <TabDragOverlay tab={activeDragTab} />}
        </DragOverlay>
      </DndContext>
    </TerminalPortalProvider>
  );
}

/**
 * Renders ALL terminal instances across ALL tab groups in a stable location in
 * the React tree. Terminal components create imperative DOM elements that are
 * adopted by TerminalSlot components in panels — this prevents unmount/remount
 * when tabs move between panels or when switching tab groups, preserving PTY
 * sessions and terminal content.
 */
function TerminalHost() {
  const tabGroups = useAppStore((s) => s.tabGroups);

  const allTabs: TerminalTab[] = useMemo(() => {
    return tabGroups
      .flatMap((g) => getAllLeaves(g.rootPanel))
      .flatMap((leaf) => leaf.tabs)
      .filter((tab) => tab.contentType === "terminal");
  }, [tabGroups]);

  return (
    <>
      {allTabs.map((tab) => (
        <Terminal
          key={tab.id}
          tabId={tab.id}
          config={tab.config}
          isVisible={tab.isActive}
          existingSessionId={tab.sessionId}
          initialCommand={tab.initialCommand}
        />
      ))}
    </>
  );
}

function TabDragOverlay({ tab }: { tab: TerminalTab }) {
  const NonTerminalIcon =
    tab.contentType === "settings"
      ? SettingsIcon
      : tab.contentType === "log-viewer"
        ? ScrollText
        : tab.contentType === "editor"
          ? FileEdit
          : tab.contentType === "connection-editor"
            ? SquarePen
            : tab.contentType === "tunnel-editor"
              ? ArrowLeftRight
              : tab.contentType === "workspace-editor"
                ? LayoutGrid
                : null;
  return (
    <div className="tab tab--drag-overlay">
      {NonTerminalIcon ? (
        <NonTerminalIcon size={14} className="tab__icon" />
      ) : (
        <ConnectionIcon config={tab.config} size={14} className="tab__icon" />
      )}
      <span className="tab__title">{tab.title}</span>
    </div>
  );
}
