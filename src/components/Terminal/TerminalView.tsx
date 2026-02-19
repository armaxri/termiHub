import { useEffect, useMemo } from "react";
import { Plus, Columns2, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { Terminal } from "./Terminal";
import { SplitView } from "@/components/SplitView";
import { terminalDispatcher } from "@/services/events";
import "./TerminalView.css";

export function TerminalView() {
  // Initialize the singleton event dispatcher once.
  // No cleanup — the dispatcher is a module-level singleton that persists for
  // the app's lifetime. Per-session subscriptions handle individual terminal
  // lifecycle. Avoiding destroy() here prevents an async race condition under
  // React StrictMode where duplicate Tauri listeners cause doubled output.
  useEffect(() => {
    terminalDispatcher.init();
  }, []);

  // Update global remote-connection state in the store (drives tab state dots).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ session_id: string; state: string }>("remote-state-change", (event) => {
      const { session_id, state } = event.payload;
      useAppStore.getState().setRemoteState(session_id, state);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Update agent connection state in the store (drives sidebar state dots).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ session_id: string; state: string }>("agent-state-change", (event) => {
      const { session_id, state } = event.payload;
      const store = useAppStore.getState();
      store.setAgentConnectionState(
        session_id,
        state as "disconnected" | "connecting" | "connected" | "reconnecting"
      );
      // Auto-refresh sessions when agent reconnects
      if (state === "connected") {
        store.refreshAgentSessions(session_id);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

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
        <Terminal
          key={tab.id}
          tabId={tab.id}
          config={tab.config}
          isVisible={tab.isActive}
          existingSessionId={tab.sessionId}
        />
      ))}
    </>
  );
}
