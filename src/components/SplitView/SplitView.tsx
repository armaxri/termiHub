import { useState, useCallback, useEffect, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Terminal as TerminalIcon, Wifi, Cable, Globe, Settings as SettingsIcon, FileEdit } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { PanelNode, LeafPanel, TerminalTab, ConnectionType, DropEdge } from "@/types/terminal";
import { getAllLeaves, findLeafByTab } from "@/utils/panelTree";
import { useTerminalRegistry } from "@/components/Terminal/TerminalRegistry";
import { TabBar } from "@/components/Terminal/TabBar";
import { SettingsPanel } from "@/components/Settings";
import { FileEditor } from "@/components/FileEditor";
import { PanelDropZone } from "./PanelDropZone";
import "./SplitView.css";

const TYPE_ICONS: Record<ConnectionType, typeof TerminalIcon> = {
  local: TerminalIcon,
  ssh: Wifi,
  serial: Cable,
  telnet: Globe,
};

export function SplitView() {
  const rootPanel = useAppStore((s) => s.rootPanel);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const moveTab = useAppStore((s) => s.moveTab);
  const splitPanelWithTab = useAppStore((s) => s.splitPanelWithTab);

  const [activeDragTab, setActiveDragTab] = useState<TerminalTab | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

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

      // Edge drop: split panel with tab
      if (overId.startsWith("edge-")) {
        const parts = overId.split("-");
        // edge-{panelId}-{edge} — panelId may contain dashes so parse carefully
        const edge = parts[parts.length - 1] as DropEdge;
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
        // Cross-panel tab drop: find index of the over tab in destination
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
    [rootPanel, reorderTabs, moveTab, splitPanelWithTab]
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <PanelNodeRenderer
        node={rootPanel}
        setActivePanel={setActivePanel}
        activeDragTab={activeDragTab}
      />
      <DragOverlay dropAnimation={null}>
        {activeDragTab && <TabDragOverlay tab={activeDragTab} />}
      </DragOverlay>
    </DndContext>
  );
}

interface PanelNodeRendererProps {
  node: PanelNode;
  setActivePanel: (panelId: string) => void;
  activeDragTab: TerminalTab | null;
}

function PanelNodeRenderer({ node, setActivePanel, activeDragTab }: PanelNodeRendererProps) {
  if (node.type === "leaf") {
    return (
      <LeafPanelView
        panel={node}
        setActivePanel={setActivePanel}
        activeDragTab={activeDragTab}
      />
    );
  }

  const orientation = node.direction === "horizontal" ? "horizontal" : "vertical";

  return (
    <Group orientation={orientation} className="split-view">
      {node.children.map((child, index) => (
        <SplitChild key={child.id} index={index}>
          <PanelNodeRenderer
            node={child}
            setActivePanel={setActivePanel}
            activeDragTab={activeDragTab}
          />
        </SplitChild>
      ))}
    </Group>
  );
}

function SplitChild({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <>
      {index > 0 && (
        <Separator className="split-view__resize-handle" />
      )}
      <Panel minSize={10}>
        {children}
      </Panel>
    </>
  );
}

interface LeafPanelViewProps {
  panel: LeafPanel;
  setActivePanel: (panelId: string) => void;
  activeDragTab: TerminalTab | null;
}

function LeafPanelView({ panel, setActivePanel, activeDragTab }: LeafPanelViewProps) {
  // Determine if edge drop zones should be hidden:
  // Hide edges on source panel if it has only 1 tab (dragging it out would leave it empty)
  const hideEdges =
    activeDragTab !== null &&
    activeDragTab.panelId === panel.id &&
    panel.tabs.length <= 1;

  return (
    <div
      className="split-view__panel-content"
      onClick={() => setActivePanel(panel.id)}
    >
      <TabBar panelId={panel.id} tabs={panel.tabs} />
      <div className="split-view__terminal-area">
        {panel.tabs.length === 0 && (
          <div className="split-view__empty">
            No terminals open. Use the toolbar or double-click a connection.
          </div>
        )}
        {panel.tabs.map((tab) =>
          tab.contentType === "settings" ? (
            <SettingsPanel
              key={tab.id}
              isVisible={tab.id === panel.activeTabId}
            />
          ) : tab.contentType === "editor" && tab.editorMeta ? (
            <FileEditor
              key={tab.id}
              tabId={tab.id}
              meta={tab.editorMeta}
              isVisible={tab.id === panel.activeTabId}
            />
          ) : (
            <TerminalSlot
              key={tab.id}
              tabId={tab.id}
              isVisible={tab.id === panel.activeTabId}
            />
          )
        )}
        {activeDragTab && (
          <PanelDropZone panelId={panel.id} hideEdges={hideEdges} />
        )}
      </div>
    </div>
  );
}

/**
 * Lightweight slot that adopts a terminal's DOM element from the registry.
 * When a tab moves between panels, the old slot parks the element and the new slot adopts it —
 * preserving the xterm instance, PTY session, and all terminal content.
 */
function TerminalSlot({ tabId, isVisible }: { tabId: string; isVisible: boolean }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const { getElement, parkingRef } = useTerminalRegistry();
  const tabColor = useAppStore((s) => s.tabColors[tabId]);

  useEffect(() => {
    const slotEl = slotRef.current;
    if (!slotEl) return;

    const tryAdopt = () => {
      const termEl = getElement(tabId);
      if (termEl && termEl.parentNode !== slotEl) {
        slotEl.appendChild(termEl);
        return true;
      }
      return !!termEl;
    };

    // Terminal may not be registered yet on initial render — retry once
    if (!tryAdopt()) {
      const rafId = requestAnimationFrame(() => tryAdopt());
      return () => cancelAnimationFrame(rafId);
    }

    return () => {
      // Park the element back so it's not orphaned
      const termEl = getElement(tabId);
      if (termEl && termEl.parentNode === slotEl) {
        parkingRef.current?.appendChild(termEl);
      }
    };
  }, [tabId, getElement, parkingRef]);

  return (
    <div
      ref={slotRef}
      className={`terminal-container ${isVisible ? "" : "terminal-container--hidden"}`}
      style={tabColor ? { border: `2px solid ${tabColor}` } : undefined}
    />
  );
}

function TabDragOverlay({ tab }: { tab: TerminalTab }) {
  const Icon = tab.contentType === "settings" ? SettingsIcon
    : tab.contentType === "editor" ? FileEdit
    : TYPE_ICONS[tab.connectionType];
  return (
    <div className="tab tab--drag-overlay">
      <Icon size={14} className="tab__icon" />
      <span className="tab__title">{tab.title}</span>
    </div>
  );
}
