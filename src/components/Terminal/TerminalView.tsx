import { useMemo } from "react";
import { Plus, Columns2, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { Terminal } from "./Terminal";
import { SplitView } from "@/components/SplitView";
import "./TerminalView.css";

export function TerminalView() {
  const addTab = useAppStore((s) => s.addTab);
  const splitPanel = useAppStore((s) => s.splitPanel);
  const rootPanel = useAppStore((s) => s.rootPanel);
  const activePanelId = useAppStore((s) => s.activePanelId);
  const removePanel = useAppStore((s) => s.removePanel);

  const allLeaves = getAllLeaves(rootPanel);

  const handleNewTerminal = () => {
    addTab("Terminal", "local");
  };

  const handleSplit = () => {
    splitPanel("horizontal");
  };

  const handleClosePanel = () => {
    if (activePanelId && allLeaves.length > 1) {
      removePanel(activePanelId);
    }
  };

  return (
    <TerminalPortalProvider>
      <div className="terminal-view">
        <div className="terminal-view__toolbar">
          <div className="terminal-view__toolbar-left">
            <span className="terminal-view__toolbar-title">Terminal</span>
          </div>
          <div className="terminal-view__toolbar-actions">
            <button
              className="terminal-view__toolbar-btn"
              onClick={handleNewTerminal}
              title="New Terminal"
              data-testid="terminal-view-new-terminal"
            >
              <Plus size={16} />
            </button>
            <button
              className="terminal-view__toolbar-btn"
              onClick={handleSplit}
              title="Split Terminal"
              data-testid="terminal-view-split"
            >
              <Columns2 size={16} />
            </button>
            {allLeaves.length > 1 && (
              <button
                className="terminal-view__toolbar-btn"
                onClick={handleClosePanel}
                title="Close Panel"
                data-testid="terminal-view-close-panel"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
        <div className="terminal-view__content">
          <TerminalHost />
          <SplitView />
        </div>
      </div>
    </TerminalPortalProvider>
  );
}

/**
 * Renders ALL terminal instances in a stable location in the React tree.
 * Terminal components create imperative DOM elements that are adopted by
 * TerminalSlot components in panels — this prevents unmount/remount when
 * tabs move between panels, preserving PTY sessions and terminal content.
 */
function TerminalHost() {
  const rootPanel = useAppStore((s) => s.rootPanel);
  const allTabs: TerminalTab[] = useMemo(() => {
    return getAllLeaves(rootPanel)
      .flatMap((leaf) => leaf.tabs)
      .filter((tab) => tab.contentType === "terminal");
  }, [rootPanel]);

  return (
    <>
      {allTabs.map((tab) => (
        <Terminal key={tab.id} tabId={tab.id} config={tab.config} isVisible={tab.isActive} />
      ))}
    </>
  );
}
