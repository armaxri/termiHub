import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { useTerminalRegistry } from "./TerminalRegistry";
import { Tab } from "./Tab";
import "./TabBar.css";

interface TabBarProps {
  panelId: string;
  tabs: TerminalTab[];
}

export function TabBar({ panelId, tabs }: TabBarProps) {
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const { clearTerminal, saveTerminalToFile } = useTerminalRegistry();

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
              onClose={() => closeTab(tab.id, panelId)}
              onClear={() => clearTerminal(tab.id)}
              onSave={() => saveTerminalToFile(tab.id)}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
