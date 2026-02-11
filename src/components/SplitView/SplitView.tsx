import { Group, Panel, Separator } from "react-resizable-panels";
import { useAppStore } from "@/store/appStore";
import { TabBar } from "@/components/Terminal/TabBar";
import { Terminal } from "@/components/Terminal/Terminal";
import "./SplitView.css";

export function SplitView() {
  const panels = useAppStore((s) => s.panels);
  const setActivePanel = useAppStore((s) => s.setActivePanel);

  if (panels.length === 0) return null;

  return (
    <Group orientation="horizontal" className="split-view">
      {panels.map((panel, index) => (
        <SplitViewPanel key={panel.id} panelIndex={index} totalPanels={panels.length}>
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
              {panel.tabs.map((tab) => (
                <Terminal
                  key={tab.id}
                  tabId={tab.id}
                  config={tab.config}
                  isVisible={tab.id === panel.activeTabId}
                />
              ))}
            </div>
          </div>
        </SplitViewPanel>
      ))}
    </Group>
  );
}

interface SplitViewPanelProps {
  panelIndex: number;
  totalPanels: number;
  children: React.ReactNode;
}

function SplitViewPanel({ panelIndex, totalPanels, children }: SplitViewPanelProps) {
  return (
    <>
      {panelIndex > 0 && (
        <Separator className="split-view__resize-handle" />
      )}
      <Panel minSize={20} defaultSize={100 / totalPanels}>
        {children}
      </Panel>
    </>
  );
}
