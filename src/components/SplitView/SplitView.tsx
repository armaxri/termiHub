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
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Settings as SettingsIcon,
  FileEdit,
  SquarePen,
  ScrollText,
  ArrowLeftRight,
  Pencil,
  FileDown,
  ClipboardCopy,
  Copy,
  Eraser,
  ArrowRightLeft,
  Check,
  Palette,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { PanelNode, LeafPanel, TerminalTab, DropEdge } from "@/types/terminal";
import { getAllLeaves, findLeafByTab } from "@/utils/panelTree";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { useTerminalRegistry } from "@/components/Terminal/TerminalRegistry";
import { TabBar } from "@/components/Terminal/TabBar";
import { ColorPickerDialog } from "@/components/Terminal/ColorPickerDialog";
import { RenameDialog } from "@/components/Terminal/RenameDialog";
import { SettingsPanel } from "@/components/Settings";
import { FileEditor } from "@/components/FileEditor";
import { ConnectionEditor } from "@/components/ConnectionEditor/ConnectionEditor";
import { LogViewer } from "@/components/LogViewer";
import { TunnelEditor } from "@/components/TunnelEditor";
import { PanelDropZone } from "./PanelDropZone";
import "./SplitView.css";

export function SplitView() {
  const rootPanel = useAppStore((s) => s.rootPanel);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const moveTab = useAppStore((s) => s.moveTab);
  const splitPanelWithTab = useAppStore((s) => s.splitPanelWithTab);

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
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
      <LeafPanelView panel={node} setActivePanel={setActivePanel} activeDragTab={activeDragTab} />
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
      {index > 0 && <Separator className="split-view__resize-handle" />}
      <Panel minSize={10}>{children}</Panel>
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
    activeDragTab !== null && activeDragTab.panelId === panel.id && panel.tabs.length <= 1;

  const renameTab = useAppStore((s) => s.renameTab);
  const tabHorizontalScrolling = useAppStore((s) => s.tabHorizontalScrolling);
  const setTabHorizontalScrolling = useAppStore((s) => s.setTabHorizontalScrolling);
  const tabColors = useAppStore((s) => s.tabColors);
  const setTabColor = useAppStore((s) => s.setTabColor);
  const {
    clearTerminal,
    saveTerminalToFile,
    copyTerminalToClipboard,
    getTerminalSelection,
    copySelectionToClipboard,
  } = useTerminalRegistry();

  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null);
  const [renameTabId, setRenameTabId] = useState<string | null>(null);
  const [contextMenuTabSelection, setContextMenuTabSelection] = useState<string | null>(null);

  const renameTabData = renameTabId ? panel.tabs.find((t) => t.id === renameTabId) : null;

  return (
    <div className="split-view__panel-content" onClick={() => setActivePanel(panel.id)}>
      <TabBar panelId={panel.id} tabs={panel.tabs} />
      <div className="split-view__terminal-area">
        {panel.tabs.length === 0 && (
          <div className="split-view__empty">
            No terminals open. Use the toolbar or double-click a connection.
          </div>
        )}
        {panel.tabs.map((tab) =>
          tab.contentType === "settings" ? (
            <SettingsPanel key={tab.id} isVisible={tab.id === panel.activeTabId} />
          ) : tab.contentType === "log-viewer" ? (
            <LogViewer key={tab.id} isVisible={tab.id === panel.activeTabId} />
          ) : tab.contentType === "editor" && tab.editorMeta ? (
            <FileEditor
              key={tab.id}
              tabId={tab.id}
              meta={tab.editorMeta}
              isVisible={tab.id === panel.activeTabId}
            />
          ) : tab.contentType === "connection-editor" && tab.connectionEditorMeta ? (
            <ConnectionEditor
              key={tab.id}
              tabId={tab.id}
              meta={tab.connectionEditorMeta}
              isVisible={tab.id === panel.activeTabId}
            />
          ) : tab.contentType === "tunnel-editor" && tab.tunnelEditorMeta ? (
            <TunnelEditor
              key={tab.id}
              tabId={tab.id}
              meta={tab.tunnelEditorMeta}
              isVisible={tab.id === panel.activeTabId}
            />
          ) : (
            <ContextMenu.Root
              key={tab.id}
              onOpenChange={(open) => {
                if (open) {
                  setContextMenuTabSelection(getTerminalSelection(tab.id) ?? null);
                }
              }}
            >
              <ContextMenu.Trigger asChild>
                <div
                  className={
                    tab.id === panel.activeTabId
                      ? "terminal-context-trigger"
                      : "terminal-context-trigger terminal-context-trigger--hidden"
                  }
                >
                  <TerminalSlot tabId={tab.id} isVisible={tab.id === panel.activeTabId} />
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="context-menu__content">
                  {contextMenuTabSelection && (
                    <ContextMenu.Item
                      className="context-menu__item"
                      onSelect={() => copySelectionToClipboard(tab.id)}
                      data-testid="terminal-context-copy-selection"
                    >
                      <Copy size={14} /> Copy Selection
                    </ContextMenu.Item>
                  )}
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => copyTerminalToClipboard(tab.id)}
                  >
                    <ClipboardCopy size={14} /> Copy All
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="context-menu__separator" />
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => setRenameTabId(tab.id)}
                  >
                    <Pencil size={14} /> Rename
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="context-menu__separator" />
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => saveTerminalToFile(tab.id)}
                  >
                    <FileDown size={14} /> Save to File
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => clearTerminal(tab.id)}
                  >
                    <Eraser size={14} /> Clear Terminal
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="context-menu__separator" />
                  <ContextMenu.CheckboxItem
                    className="context-menu__item"
                    checked={tabHorizontalScrolling[tab.id] ?? false}
                    onSelect={() =>
                      setTabHorizontalScrolling(tab.id, !(tabHorizontalScrolling[tab.id] ?? false))
                    }
                  >
                    <ContextMenu.ItemIndicator className="context-menu__indicator">
                      <Check size={14} />
                    </ContextMenu.ItemIndicator>
                    <ArrowRightLeft size={14} /> Horizontal Scrolling
                  </ContextMenu.CheckboxItem>
                  <ContextMenu.Separator className="context-menu__separator" />
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => setColorPickerTabId(tab.id)}
                  >
                    <Palette size={14} /> Set Color...
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          )
        )}
        {activeDragTab && <PanelDropZone panelId={panel.id} hideEdges={hideEdges} />}
      </div>
      <ColorPickerDialog
        open={colorPickerTabId !== null}
        onOpenChange={(open) => {
          if (!open) setColorPickerTabId(null);
        }}
        currentColor={colorPickerTabId ? tabColors[colorPickerTabId] : undefined}
        onColorChange={(color) => {
          if (colorPickerTabId) setTabColor(colorPickerTabId, color);
        }}
      />
      <RenameDialog
        open={renameTabId !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTabId(null);
        }}
        currentTitle={renameTabData?.title ?? ""}
        onRename={(newTitle) => {
          if (renameTabId) renameTab(renameTabId, newTitle);
        }}
      />
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
  const { getElement, focusTerminal, parkingRef } = useTerminalRegistry();
  const tabColor = useAppStore((s) => s.tabColors[tabId]);

  useEffect(() => {
    const slotEl = slotRef.current;
    if (!slotEl) return;

    // Capture ref value so cleanup uses the same node even if the ref changes
    const parkingEl = parkingRef.current;

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
        parkingEl?.appendChild(termEl);
      }
    };
  }, [tabId, getElement, parkingRef]);

  // Focus the terminal when it becomes visible (tab activation or initial creation)
  useEffect(() => {
    if (isVisible) {
      focusTerminal(tabId);
    }
  }, [isVisible, tabId, focusTerminal]);

  return (
    <div
      ref={slotRef}
      className={`terminal-container ${isVisible ? "" : "terminal-container--hidden"}`}
      style={tabColor ? { border: `2px solid ${tabColor}` } : undefined}
    />
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
