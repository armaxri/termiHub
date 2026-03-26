import { useState, useCallback, useEffect, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Pencil,
  FileDown,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Eraser,
  ArrowRightLeft,
  Check,
  Palette,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { PanelNode, LeafPanel, TerminalTab } from "@/types/terminal";
import { isWindows } from "@/utils/platform";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
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
import { TerminalSearchBar } from "@/components/Terminal/TerminalSearchBar";
import { PanelDropZone } from "./PanelDropZone";
import "./SplitView.css";

/** Props for SplitView — the DndContext now lives in TerminalView. */
export interface SplitViewProps {
  activeDragTab: TerminalTab | null;
}

/**
 * Renders all tab groups' panel trees.
 * Only the active group is visible; inactive groups are hidden via CSS so that
 * all terminal sessions stay mounted and alive (session preservation).
 * The DndContext lives in TerminalView and is passed as `activeDragTab`.
 */
export function SplitView({ activeDragTab }: SplitViewProps) {
  const tabGroups = useAppStore((s) => s.tabGroups);
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId);
  const setActivePanel = useAppStore((s) => s.setActivePanel);

  return (
    <div className="split-view-container">
      {tabGroups.map((group) => (
        <div
          key={group.id}
          className="split-view-group"
          style={{ display: group.id === activeTabGroupId ? "flex" : "none" }}
        >
          <PanelNodeRenderer
            node={group.rootPanel}
            setActivePanel={setActivePanel}
            activeDragTab={activeDragTab}
          />
        </div>
      ))}
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

  const renameTab = useAppStore((s) => s.renameTab);
  const tabHorizontalScrolling = useAppStore((s) => s.tabHorizontalScrolling);
  const setTabHorizontalScrolling = useAppStore((s) => s.setTabHorizontalScrolling);
  const tabColors = useAppStore((s) => s.tabColors);
  const setTabColor = useAppStore((s) => s.setTabColor);
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
          ) : tab.contentType === "workspace-editor" && tab.workspaceEditorMeta ? (
            <WorkspaceEditor
              key={tab.id}
              tabId={tab.id}
              meta={tab.workspaceEditorMeta}
              isVisible={tab.id === panel.activeTabId}
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
              <TerminalSlot tabId={tab.id} isVisible={tab.id === panel.activeTabId} />
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
