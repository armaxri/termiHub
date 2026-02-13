import { useState } from "react";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { useTerminalRegistry } from "./TerminalRegistry";
import { Tab } from "./Tab";
import { ColorPickerDialog } from "./ColorPickerDialog";
import "./TabBar.css";

interface TabBarProps {
  panelId: string;
  tabs: TerminalTab[];
}

export function TabBar({ panelId, tabs }: TabBarProps) {
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const tabHorizontalScrolling = useAppStore((s) => s.tabHorizontalScrolling);
  const setTabHorizontalScrolling = useAppStore((s) => s.setTabHorizontalScrolling);
  const tabColors = useAppStore((s) => s.tabColors);
  const setTabColor = useAppStore((s) => s.setTabColor);
  const editorDirtyTabs = useAppStore((s) => s.editorDirtyTabs);
  const { clearTerminal, saveTerminalToFile, copyTerminalToClipboard } = useTerminalRegistry();

  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null);

  const handleCloseTab = (tabId: string) => {
    if (editorDirtyTabs[tabId]) {
      if (!window.confirm("This file has unsaved changes. Close anyway?")) return;
    }
    closeTab(tabId, panelId);
  };

  return (
    <div className="tab-bar">
      <SortableContext
        items={tabs.map((t) => t.id)}
        strategy={horizontalListSortingStrategy}
      >
        <div className="tab-bar__tabs">
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              tab={tab}
              onActivate={() => setActiveTab(tab.id, panelId)}
              onClose={() => handleCloseTab(tab.id)}
              onClear={() => clearTerminal(tab.id)}
              onSave={() => saveTerminalToFile(tab.id)}
              onCopyToClipboard={() => copyTerminalToClipboard(tab.id)}
              horizontalScrolling={tabHorizontalScrolling[tab.id] ?? false}
              onToggleHorizontalScrolling={() => setTabHorizontalScrolling(tab.id, !(tabHorizontalScrolling[tab.id] ?? false))}
              isDirty={editorDirtyTabs[tab.id] ?? false}
              tabColor={tabColors[tab.id]}
              onSetColor={() => setColorPickerTabId(tab.id)}
            />
          ))}
        </div>
      </SortableContext>
      <ColorPickerDialog
        open={colorPickerTabId !== null}
        onOpenChange={(open) => { if (!open) setColorPickerTabId(null); }}
        currentColor={colorPickerTabId ? tabColors[colorPickerTabId] : undefined}
        onColorChange={(color) => {
          if (colorPickerTabId) setTabColor(colorPickerTabId, color);
        }}
      />
    </div>
  );
}
