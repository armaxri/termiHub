import { useState, useCallback, useEffect, useRef, useMemo } from "react";
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
  LayoutGrid,
  Pencil,
  FileDown,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Eraser,
  ArrowRightLeft,
  Check,
  Palette,
  Stethoscope,
  WifiOff,
  X,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { PanelNode, LeafPanel, TerminalTab, DropEdge } from "@/types/terminal";
import { getAllLeaves, findLeafByTab } from "@/utils/panelTree";
import { isWindows, isMac } from "@/utils/platform";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
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
import { WorkspaceEditor } from "@/components/WorkspaceEditor";
import { NetworkDiagnosticPanel } from "@/components/NetworkTools/NetworkDiagnosticPanel";
import { TerminalSearchBar } from "@/components/Terminal/TerminalSearchBar";
import { AgentErrorTab } from "@/components/Terminal/AgentErrorTab";
import { TerminalSpawnErrorOverlay } from "@/components/Terminal/TerminalSpawnErrorOverlay";
import { PanelDropZone } from "./PanelDropZone";
import "./SplitView.css";

export function SplitView() {
  const rootPanel = useAppStore((s) => s.rootPanel);
  const tabGroups = useAppStore((s) => s.tabGroups);
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const addTabGroupWithTab = useAppStore((s) => s.addTabGroupWithTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const moveTab = useAppStore((s) => s.moveTab);
  const splitPanelWithTab = useAppStore((s) => s.splitPanelWithTab);
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup);
  const setDraggingTabId = useAppStore((s) => s.setDraggingTabId);
  const zoomedTabId = useAppStore((s) => s.zoomedTabId);
  const setZoomedTabId = useAppStore((s) => s.setZoomedTabId);
  const terminalSpawnErrors = useAppStore((s) => s.terminalSpawnErrors);

  // Find the zoomed tab's metadata for the overlay header
  const zoomedTab = useMemo(() => {
    if (!zoomedTabId) return null;
    for (const leaf of getAllLeaves(rootPanel)) {
      const tab = leaf.tabs.find((t) => t.id === zoomedTabId);
      if (tab) return tab;
    }
    return null;
  }, [zoomedTabId, rootPanel]);

  const dismissZoom = useCallback(() => setZoomedTabId(null), [setZoomedTabId]);

  // Close the zoom overlay on Escape (capture phase to intercept before xterm)
  useEffect(() => {
    if (!zoomedTabId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setZoomedTabId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [zoomedTabId, setZoomedTabId]);

  const [activeDragTab, setActiveDragTab] = useState<TerminalTab | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const tabId = event.active.id as string;
      const leaf = findLeafByTab(rootPanel, tabId);
      if (!leaf) return;
      const tab = leaf.tabs.find((t) => t.id === tabId);
      if (tab) {
        setActiveDragTab(tab);
        setDraggingTabId(tabId);
      }
    },
    [rootPanel, setDraggingTabId]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragTab(null);
      setDraggingTabId(null);
      const { active, over } = event;

      const tabId = active.id as string;
      const fromPanelId = (active.data.current as { panelId?: string })?.panelId;
      if (!fromPanelId) return;

      // If not dropped on any registered droppable, check for special drop targets
      // outside the DndContext (group chips, new-tab button) using elementsFromPoint.
      // Use elementsFromPoint (plural) to look through the DragOverlay which may be
      // rendered at the same coordinates and would block elementFromPoint.
      if (!over) {
        const ae = event.activatorEvent as PointerEvent;
        if (ae.clientX !== undefined) {
          const finalX = ae.clientX + event.delta.x;
          const finalY = ae.clientY + event.delta.y;
          const elements = document.elementsFromPoint(finalX, finalY);
          for (const el of elements) {
            // Cross-group chip drop
            const chipEl = el.closest("[data-tab-group-id]");
            if (chipEl) {
              const targetGroupId = chipEl.getAttribute("data-tab-group-id");
              if (targetGroupId) moveTabToGroup(tabId, fromPanelId, targetGroupId);
              break;
            }
            // New-group button drop: create a new tab group and move the tab into it
            if (el.closest("[data-new-group-btn]")) {
              addTabGroupWithTab(tabId, fromPanelId);
              break;
            }
          }
        }
        return;
      }

      const overId = over.id as string;

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
    [
      rootPanel,
      addTabGroupWithTab,
      reorderTabs,
      moveTab,
      splitPanelWithTab,
      moveTabToGroup,
      setDraggingTabId,
    ]
  );

  return (
    <div className="split-view-groups">
      {tabGroups.map((group) => {
        const isActive = group.id === activeTabGroupId;
        // Active group: use live rootPanel state (always up-to-date).
        // Inactive groups: use saved rootPanel from tabGroups (preserved on switch).
        const panelTree = isActive ? rootPanel : group.rootPanel;
        return (
          <div
            key={group.id}
            className={`split-view-group${isActive ? " split-view-group--active" : ""}`}
          >
            {/* Each group has its own DndContext.
                Inactive groups' DndContexts are needed to satisfy @dnd-kit hooks
                (SortableContext in TabBar, useDroppable in PanelDropZone) but
                receive no events since their container is display:none. */}
            <DndContext
              sensors={sensors}
              onDragStart={isActive ? handleDragStart : undefined}
              onDragEnd={isActive ? handleDragEnd : undefined}
            >
              <PanelNodeRenderer
                node={panelTree}
                setActivePanel={isActive ? setActivePanel : () => {}}
                activeDragTab={isActive ? activeDragTab : null}
              />
              {isActive && (
                <DragOverlay dropAnimation={null}>
                  {activeDragTab && <TabDragOverlay tab={activeDragTab} />}
                </DragOverlay>
              )}
            </DndContext>
          </div>
        );
      })}
      {zoomedTabId && zoomedTab && (
        <div className="zoom-overlay" onClick={dismissZoom}>
          <div className="zoom-overlay__panel" onClick={(e) => e.stopPropagation()}>
            <div className="zoom-overlay__header">
              {zoomedTab.contentType === "settings" ? (
                <SettingsIcon size={14} className="zoom-overlay__icon" />
              ) : zoomedTab.contentType === "log-viewer" ? (
                <ScrollText size={14} className="zoom-overlay__icon" />
              ) : zoomedTab.contentType === "editor" ? (
                <FileEdit size={14} className="zoom-overlay__icon" />
              ) : zoomedTab.contentType === "connection-editor" ? (
                <SquarePen size={14} className="zoom-overlay__icon" />
              ) : zoomedTab.contentType === "tunnel-editor" ? (
                <ArrowLeftRight size={14} className="zoom-overlay__icon" />
              ) : zoomedTab.contentType === "workspace-editor" ? (
                <LayoutGrid size={14} className="zoom-overlay__icon" />
              ) : zoomedTab.contentType === "network-diagnostic" ? (
                <Stethoscope size={14} className="zoom-overlay__icon" />
              ) : zoomedTab.contentType === "agent-error" ? (
                <WifiOff size={14} className="zoom-overlay__icon" />
              ) : (
                <ConnectionIcon
                  config={zoomedTab.config}
                  size={14}
                  className="zoom-overlay__icon"
                />
              )}
              <span className="zoom-overlay__title">{zoomedTab.title}</span>
              <span className="zoom-overlay__hint">
                {isMac() ? "⌘⇧↵" : "Ctrl+Shift+Enter"} · Esc to close
              </span>
              <button
                className="zoom-overlay__close"
                onClick={dismissZoom}
                aria-label="Close zoom overlay"
              >
                <X size={16} />
              </button>
            </div>
            <div className="zoom-overlay__content">
              {zoomedTab.contentType === "terminal" && terminalSpawnErrors[zoomedTabId] ? (
                <TerminalSpawnErrorOverlay
                  key={`zoom-${zoomedTabId}`}
                  tabId={zoomedTabId}
                  error={terminalSpawnErrors[zoomedTabId]}
                  tabTitle={zoomedTab.title}
                  isVisible={true}
                />
              ) : zoomedTab.contentType === "terminal" ? (
                <>
                  <TerminalSearchBar tabId={zoomedTabId} />
                  {/* key forces a fresh mount on each zoomed-tab change so the
                      adoption lifecycle always matches the initial-zoom case. */}
                  <TerminalSlot
                    key={`zoom-slot-${zoomedTabId}`}
                    tabId={zoomedTabId}
                    isVisible={true}
                  />
                </>
              ) : zoomedTab.contentType === "settings" ? (
                <SettingsPanel isVisible={true} />
              ) : zoomedTab.contentType === "log-viewer" ? (
                <LogViewer isVisible={true} />
              ) : zoomedTab.contentType === "editor" && zoomedTab.editorMeta ? (
                <FileEditor
                  key={`zoom-${zoomedTabId}`}
                  tabId={zoomedTabId}
                  meta={zoomedTab.editorMeta}
                  isVisible={true}
                  keepModel={true}
                />
              ) : zoomedTab.contentType === "connection-editor" &&
                zoomedTab.connectionEditorMeta ? (
                <ConnectionEditor
                  key={`zoom-${zoomedTabId}`}
                  tabId={zoomedTabId}
                  meta={zoomedTab.connectionEditorMeta}
                  isVisible={true}
                />
              ) : zoomedTab.contentType === "tunnel-editor" && zoomedTab.tunnelEditorMeta ? (
                <TunnelEditor
                  key={`zoom-${zoomedTabId}`}
                  tabId={zoomedTabId}
                  meta={zoomedTab.tunnelEditorMeta}
                  isVisible={true}
                />
              ) : zoomedTab.contentType === "workspace-editor" && zoomedTab.workspaceEditorMeta ? (
                <WorkspaceEditor
                  key={`zoom-${zoomedTabId}`}
                  tabId={zoomedTabId}
                  meta={zoomedTab.workspaceEditorMeta}
                  isVisible={true}
                />
              ) : zoomedTab.contentType === "network-diagnostic" &&
                zoomedTab.networkDiagnosticMeta ? (
                <NetworkDiagnosticPanel
                  key={`zoom-${zoomedTabId}`}
                  meta={zoomedTab.networkDiagnosticMeta}
                  isVisible={true}
                />
              ) : zoomedTab.contentType === "agent-error" && zoomedTab.agentErrorMeta ? (
                <AgentErrorTab
                  key={`zoom-${zoomedTabId}`}
                  tabId={zoomedTabId}
                  meta={zoomedTab.agentErrorMeta}
                  isVisible={true}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
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
        <SplitChild key={child.id} index={index} defaultSize={node.sizes?.[index]}>
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

function SplitChild({
  index,
  defaultSize,
  children,
}: {
  index: number;
  defaultSize?: number;
  children: React.ReactNode;
}) {
  return (
    <>
      {index > 0 && <Separator className="split-view__resize-handle" />}
      <Panel minSize={10} defaultSize={defaultSize}>
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
    activeDragTab !== null && activeDragTab.panelId === panel.id && panel.tabs.length <= 1;

  const zoomedTabId = useAppStore((s) => s.zoomedTabId);
  const renameTab = useAppStore((s) => s.renameTab);
  const tabHorizontalScrolling = useAppStore((s) => s.tabHorizontalScrolling);
  const setTabHorizontalScrolling = useAppStore((s) => s.setTabHorizontalScrolling);
  const tabColors = useAppStore((s) => s.tabColors);
  const setTabColor = useAppStore((s) => s.setTabColor);
  const terminalSpawnErrors = useAppStore((s) => s.terminalSpawnErrors);
  const rightClickBehavior = useAppStore((s) => s.settings.rightClickBehavior);
  const useQuickAction =
    rightClickBehavior === "quickAction" || (!rightClickBehavior && isWindows());

  const {
    clearTerminal,
    saveTerminalToFile,
    copyTerminalToClipboard,
    getTerminalSelection,
    clearTerminalSelection,
    copySelectionToClipboard,
    pasteToTerminal,
  } = useTerminalRegistry();

  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null);
  const [renameTabId, setRenameTabId] = useState<string | null>(null);
  const [contextMenuTabSelection, setContextMenuTabSelection] = useState<string | null>(null);

  // Capture selection BEFORE right-click modifies it (xterm auto-selects word on right-click)
  const preRightClickSelectionRef = useRef<string | null>(null);

  const captureSelectionBeforeRightClick = useCallback(
    (e: React.PointerEvent, tabId: string) => {
      if (e.button === 2) {
        preRightClickSelectionRef.current = getTerminalSelection(tabId) ?? null;
      }
    },
    [getTerminalSelection]
  );

  const handleQuickAction = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.preventDefault();
      const selection = preRightClickSelectionRef.current;
      preRightClickSelectionRef.current = null;
      if (selection) {
        writeClipboard(selection);
        clearTerminalSelection(tabId);
      } else {
        clearTerminalSelection(tabId);
        pasteToTerminal(tabId);
      }
    },
    [clearTerminalSelection, pasteToTerminal]
  );

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
            <SettingsPanel
              key={tab.id}
              isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
            />
          ) : tab.contentType === "log-viewer" ? (
            <LogViewer
              key={tab.id}
              isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
            />
          ) : tab.contentType === "editor" && tab.editorMeta ? (
            <FileEditor
              key={tab.id}
              tabId={tab.id}
              meta={tab.editorMeta}
              isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
            />
          ) : tab.contentType === "connection-editor" && tab.connectionEditorMeta ? (
            <ConnectionEditor
              key={tab.id}
              tabId={tab.id}
              meta={tab.connectionEditorMeta}
              isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
            />
          ) : tab.contentType === "tunnel-editor" && tab.tunnelEditorMeta ? (
            <TunnelEditor
              key={tab.id}
              tabId={tab.id}
              meta={tab.tunnelEditorMeta}
              isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
            />
          ) : tab.contentType === "workspace-editor" && tab.workspaceEditorMeta ? (
            <WorkspaceEditor
              key={tab.id}
              tabId={tab.id}
              meta={tab.workspaceEditorMeta}
              isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
            />
          ) : tab.contentType === "network-diagnostic" && tab.networkDiagnosticMeta ? (
            <NetworkDiagnosticPanel
              key={tab.id}
              meta={tab.networkDiagnosticMeta}
              isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
            />
          ) : tab.contentType === "agent-error" && tab.agentErrorMeta ? (
            <AgentErrorTab
              key={tab.id}
              tabId={tab.id}
              meta={tab.agentErrorMeta}
              isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
            />
          ) : tab.contentType === "terminal" && terminalSpawnErrors[tab.id] ? (
            <TerminalSpawnErrorOverlay
              key={tab.id}
              tabId={tab.id}
              error={terminalSpawnErrors[tab.id]}
              tabTitle={tab.title}
              isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
            />
          ) : useQuickAction ? (
            <div
              key={tab.id}
              className={
                tab.id === panel.activeTabId
                  ? "terminal-context-trigger"
                  : "terminal-context-trigger terminal-context-trigger--hidden"
              }
              onPointerDownCapture={(e) => captureSelectionBeforeRightClick(e, tab.id)}
              onContextMenu={(e) => handleQuickAction(e, tab.id)}
            >
              <TerminalSearchBar tabId={tab.id} />
              <TerminalSlot
                key={`ts-${tab.id}-${zoomedTabId === tab.id ? "z" : "n"}`}
                tabId={tab.id}
                isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
              />
            </div>
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
                  <TerminalSearchBar tabId={tab.id} />
                  <TerminalSlot
                    key={`ts-${tab.id}-${zoomedTabId === tab.id ? "z" : "n"}`}
                    tabId={tab.id}
                    isVisible={tab.id === panel.activeTabId && zoomedTabId !== tab.id}
                  />
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
                    onSelect={() => pasteToTerminal(tab.id)}
                    data-testid="terminal-context-paste"
                  >
                    <ClipboardPaste size={14} /> Paste
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => copyTerminalToClipboard(tab.id)}
                    data-testid="terminal-context-copy-all"
                  >
                    <ClipboardCopy size={14} /> Copy All
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="context-menu__separator" />
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => setRenameTabId(tab.id)}
                    data-testid="tab-context-rename"
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
  const { getElement, focusTerminal, fitTerminal, parkingRef } = useTerminalRegistry();
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
        // Synchronous fit immediately after reparenting: getComputedStyle forces
        // layout so proposeDimensions() sees the new container dimensions.
        fitTerminal(tabId);
        // RAF fit as a second pass after the browser has painted the new layout.
        requestAnimationFrame(() => fitTerminal(tabId));
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
  }, [tabId, getElement, fitTerminal, parkingRef]);

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
              : tab.contentType === "workspace-editor"
                ? LayoutGrid
                : tab.contentType === "network-diagnostic"
                  ? Stethoscope
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
