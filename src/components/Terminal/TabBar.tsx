import { useState } from "react";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { deriveTabStatus } from "@/utils/tabStatus";
import { useTerminalRegistry } from "./TerminalRegistry";
import { Tab } from "./Tab";
import { ColorPickerDialog } from "./ColorPickerDialog";
import { RenameDialog } from "./RenameDialog";
import "./TabBar.css";

interface TabBarProps {
  panelId: string;
  tabs: TerminalTab[];
}

export function TabBar({ panelId, tabs }: TabBarProps) {
  const isFocused = useAppStore((s) => s.activePanelId === panelId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const tabHorizontalScrolling = useAppStore((s) => s.tabHorizontalScrolling);
  const setTabHorizontalScrolling = useAppStore((s) => s.setTabHorizontalScrolling);
  const tabColors = useAppStore((s) => s.tabColors);
  const setTabColor = useAppStore((s) => s.setTabColor);
  const renameTab = useAppStore((s) => s.renameTab);
  const editorDirtyTabs = useAppStore((s) => s.editorDirtyTabs);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);
  // Tab-id-keyed lifecycle maps that drive the per-tab connection status dot.
  const terminalConnecting = useAppStore((s) => s.terminalConnecting);
  const terminalReconnectingTabs = useAppStore((s) => s.terminalReconnectingTabs);
  const terminalSpawnErrors = useAppStore((s) => s.terminalSpawnErrors);
  const terminalDisconnectErrors = useAppStore((s) => s.terminalDisconnectErrors);
  const terminalExitedTabs = useAppStore((s) => s.terminalExitedTabs);
  const { clearTerminal, saveTerminalToFile, copyTerminalToClipboard, openTerminalInEditor } =
    useTerminalRegistry();

  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null);
  const [renameTabId, setRenameTabId] = useState<string | null>(null);

  const handleCloseTab = (tabId: string) => {
    // Read fresh state directly from the store to avoid stale closure values:
    // the render-time editorDirtyTabs snapshot may lag behind a setEditorDirty
    // call that hasn't caused a re-render yet (e.g. the user reverted changes).
    const isDirty = useAppStore.getState().editorDirtyTabs[tabId];
    if (isDirty) {
      const tab = tabs.find((t) => t.id === tabId);
      if (
        tab?.contentType === "connection-editor" ||
        tab?.contentType === "settings" ||
        tab?.contentType === "editor"
      ) {
        setPendingCloseRequest({ tabId, panelId });
        return;
      }
      if (!window.confirm("This file has unsaved changes. Close anyway?")) return;
    }
    closeTab(tabId, panelId);
  };

  const renameTabData = renameTabId ? tabs.find((t) => t.id === renameTabId) : null;

  return (
    <div className={`tab-bar${isFocused ? " tab-bar--focused" : ""}`}>
      <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        <div className="tab-bar__tabs">
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              tab={tab}
              onActivate={() => setActiveTab(tab.id, panelId)}
              onClose={() => handleCloseTab(tab.id)}
              onClear={() => clearTerminal(tab.id)}
              onSave={() => saveTerminalToFile(tab.id)}
              onOpenInEditor={() => openTerminalInEditor(tab.id, tab.title)}
              onCopyToClipboard={() => copyTerminalToClipboard(tab.id)}
              horizontalScrolling={tabHorizontalScrolling[tab.id] ?? false}
              onToggleHorizontalScrolling={() =>
                setTabHorizontalScrolling(tab.id, !(tabHorizontalScrolling[tab.id] ?? false))
              }
              isDirty={editorDirtyTabs[tab.id] ?? false}
              tabColor={tabColors[tab.id]}
              onRename={() => setRenameTabId(tab.id)}
              onSetColor={() => setColorPickerTabId(tab.id)}
              status={
                tab.contentType === "terminal"
                  ? deriveTabStatus(
                      {
                        terminalConnecting,
                        terminalReconnectingTabs,
                        terminalSpawnErrors,
                        terminalDisconnectErrors,
                        terminalExitedTabs,
                      },
                      tab.id
                    )
                  : undefined
              }
            />
          ))}
        </div>
      </SortableContext>
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
