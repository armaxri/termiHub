import { Plus, Columns2, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { SplitView } from "@/components/SplitView";
import "./TerminalView.css";

export function TerminalView() {
  const addTab = useAppStore((s) => s.addTab);
  const splitPanel = useAppStore((s) => s.splitPanel);
  const panels = useAppStore((s) => s.panels);
  const activePanelId = useAppStore((s) => s.activePanelId);
  const removePanel = useAppStore((s) => s.removePanel);

  const handleNewTerminal = () => {
    addTab("Terminal", "local");
  };

  const handleSplit = () => {
    splitPanel();
  };

  const handleClosePanel = () => {
    if (activePanelId && panels.length > 1) {
      removePanel(activePanelId);
    }
  };

  return (
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
          >
            <Plus size={16} />
          </button>
          <button
            className="terminal-view__toolbar-btn"
            onClick={handleSplit}
            title="Split Terminal"
          >
            <Columns2 size={16} />
          </button>
          {panels.length > 1 && (
            <button
              className="terminal-view__toolbar-btn"
              onClick={handleClosePanel}
              title="Close Panel"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="terminal-view__content">
        <SplitView />
      </div>
    </div>
  );
}
