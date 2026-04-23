import { useEffect, useMemo, useRef, useCallback } from "react";
import { Plus, Columns2, Rows2, X, PanelLeft, FileInput } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { TerminalCommandBridge } from "./TerminalCommandBridge";
import { Terminal } from "./Terminal";
import { TabGroupChips } from "./TabGroupChips";
import { SplitView } from "@/components/SplitView";
import { terminalDispatcher } from "@/services/events";
import { sendInput } from "@/services/api";
import { useOsFileDrop } from "@/hooks/useOsFileDrop";
import { frontendLog } from "@/utils/frontendLog";
import "./TerminalView.css";

/** Shell-safe quoting for a file path dropped onto a terminal. */
function quotePath(path: string): string {
  if (/^[A-Za-z]:/.test(path) || path.includes("\\")) {
    return `"${path.replace(/"/g, '\\"')}"`;
  }
  return `'${path.replace(/'/g, "'\\''")}'`;
}

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
      frontendLog("disconnect", `remote-state-change session=${session_id} state=${state}`);
      useAppStore.getState().setRemoteState(session_id, state);
      if (state === "disconnected") {
        // Find the tab that owns this session and show the disconnect overlay.
        const store = useAppStore.getState();
        const allTabs = [
          ...getAllLeaves(store.rootPanel).flatMap((l) => l.tabs),
          ...store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
        ];
        const tab = allTabs.find((t) => t.sessionId === session_id);
        if (tab) {
          frontendLog("disconnect", `remote-state-change: marking tab=${tab.id} as exited`);
          store.setTerminalExited(tab.id);
        } else {
          frontendLog("disconnect", `remote-state-change: no tab found for session=${session_id}`);
        }
      }
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
      frontendLog("disconnect", `agent-state-change agent=${session_id} state=${state}`);
      const store = useAppStore.getState();
      store.setAgentConnectionState(
        session_id,
        state as "disconnected" | "connecting" | "connected" | "reconnecting"
      );
      if (state === "connected") {
        store.refreshAgentSessions(session_id);
      } else if (state === "disconnected") {
        // Mark all terminal tabs belonging to this agent as exited so the
        // disconnect overlay appears. Must happen before clearAgentSessions
        // which wipes the session list used for cross-referencing.
        const agentSessionIds = new Set(
          (store.agentSessions[session_id] ?? []).map((s) => s.sessionId)
        );
        frontendLog(
          "disconnect",
          `agent disconnected: ${agentSessionIds.size} sessions to mark exited`
        );
        if (agentSessionIds.size > 0) {
          const allTabs = [
            ...getAllLeaves(store.rootPanel).flatMap((l) => l.tabs),
            ...store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
          ];
          for (const tab of allTabs) {
            if (tab.sessionId && agentSessionIds.has(tab.sessionId)) {
              frontendLog("disconnect", `agent disconnect: marking tab=${tab.id} as exited`);
              store.setTerminalExited(tab.id);
            }
          }
        }
        // Active sessions are gone; clear them so stale entries don't linger.
        // Saved connections (definitions/folders) are kept — they live on disk.
        store.clearAgentSessions(session_id);
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
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const sidebarToggleTitle = `Toggle Sidebar (${isMac ? "Cmd" : "Ctrl"}+B)`;

  const terminalContentRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useAppStore((s) => getActiveTab(s)?.sessionId ?? null);

  const handleTerminalDrop = useCallback(
    async (paths: string[]) => {
      if (!activeSessionId || paths.length === 0) return;
      const text = paths.map(quotePath).join(" ");
      await sendInput(activeSessionId, text);
    },
    [activeSessionId]
  );

  const { isDragOver: isTerminalDragOver } = useOsFileDrop(terminalContentRef, handleTerminalDrop);

  const allLeaves = getAllLeaves(rootPanel);

  const handleNewTerminal = () => {
    addTab("Terminal", "local");
  };

  const handleSplitHorizontal = () => {
    splitPanel("horizontal");
  };

  const handleSplitVertical = () => {
    splitPanel("vertical");
  };

  const handleClosePanel = () => {
    if (activePanelId && allLeaves.length > 1) {
      removePanel(activePanelId);
    }
  };

  return (
    <TerminalPortalProvider>
      <TerminalCommandBridge />
      <div className="terminal-view">
        <div className="terminal-view__toolbar">
          <TabGroupChips />
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
              onClick={handleSplitHorizontal}
              title="Split Terminal Right"
              data-testid="terminal-view-split-horizontal"
            >
              <Columns2 size={16} />
            </button>
            <button
              className="terminal-view__toolbar-btn"
              onClick={handleSplitVertical}
              title="Split Terminal Down"
              data-testid="terminal-view-split-vertical"
            >
              <Rows2 size={16} />
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
            <button
              className={`terminal-view__toolbar-btn${!sidebarCollapsed ? " terminal-view__toolbar-btn--active" : ""}`}
              onClick={toggleSidebar}
              title={sidebarToggleTitle}
              data-testid="terminal-view-toggle-sidebar"
            >
              <PanelLeft size={16} />
            </button>
          </div>
        </div>
        <div className="terminal-view__content" ref={terminalContentRef}>
          {isTerminalDragOver && activeSessionId && (
            <div className="terminal-view__drag-overlay">
              <FileInput size={24} />
              <span>Drop to insert path</span>
            </div>
          )}
          <TerminalHost />
          <SplitView />
        </div>
      </div>
    </TerminalPortalProvider>
  );
}

/**
 * Renders ALL terminal instances across ALL tab groups in a stable location
 * in the React tree. Terminal components create imperative DOM elements that
 * are adopted by TerminalSlot components in panels — this prevents
 * unmount/remount when tabs move between panels or groups, preserving PTY
 * sessions and terminal content.
 */
function TerminalHost() {
  const rootPanel = useAppStore((s) => s.rootPanel);
  const tabGroups = useAppStore((s) => s.tabGroups);
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId);

  const allTabs: TerminalTab[] = useMemo(() => {
    // Active group: use live rootPanel (always up-to-date)
    const activeTabs = getAllLeaves(rootPanel)
      .flatMap((leaf) => leaf.tabs)
      .filter((tab) => tab.contentType === "terminal");

    // Inactive groups: use saved rootPanel from tabGroups store
    const inactiveTabs = tabGroups
      .filter((g) => g.id !== activeTabGroupId)
      .flatMap((g) => getAllLeaves(g.rootPanel).flatMap((leaf) => leaf.tabs))
      .filter((tab) => tab.contentType === "terminal");

    return [...activeTabs, ...inactiveTabs];
  }, [rootPanel, tabGroups, activeTabGroupId]);

  return (
    <>
      {allTabs.map((tab) => (
        <Terminal
          key={tab.id}
          tabId={tab.id}
          config={tab.config}
          isVisible={tab.isActive}
          existingSessionId={tab.sessionId}
          initialCommand={tab.initialCommand}
        />
      ))}
    </>
  );
}
