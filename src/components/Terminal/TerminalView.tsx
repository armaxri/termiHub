import { useEffect, useMemo } from "react";
import { Plus, Columns2, Rows2, X, PanelLeft } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import { Tooltip } from "@/components/ui";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { TerminalCommandBridge } from "./TerminalCommandBridge";
import { TestBridge } from "@/testbridge/TestBridge";
import { Terminal } from "./Terminal";
import { TabGroupChips } from "./TabGroupChips";
import { SplitView } from "@/components/SplitView";
import { terminalDispatcher } from "@/services/events";
import { listAgentSessions } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
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
          // Remote peer dropped the connection — no exit code available (#1121).
          store.setTerminalExited(tab.id, { code: null, reason: "dropped" });
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
    listen<{ session_id: string; state: string; error?: string }>(
      "agent-state-change",
      async (event) => {
        const { session_id, state, error } = event.payload;
        frontendLog("disconnect", `agent-state-change agent=${session_id} state=${state}`);
        const store = useAppStore.getState();
        store.setAgentConnectionState(
          session_id,
          state as "disconnected" | "connecting" | "connected" | "reconnecting"
        );

        // Build the full tab list once and reuse across all branches.
        const allTabs = [
          ...getAllLeaves(store.rootPanel).flatMap((l) => l.tabs),
          ...store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
        ];

        // Find all terminal tabs that belong to this agent via their connection
        // config. This is more reliable than cross-referencing through
        // agentSessions, which is only populated once on initial connect and
        // therefore empty for sessions opened after the first refresh.
        const agentTerminalTabs = allTabs.filter((tab) => {
          if (tab.contentType !== "terminal") return false;
          const cfg = tab.config.config as { agentId?: string };
          return cfg.agentId === session_id;
        });

        if (state === "connected") {
          // Query the agent for sessions it actually recovered. Daemons that
          // survived the power cycle are re-attached with the same session IDs;
          // those that didn't are silently dropped by the agent.
          let recoveredSessionIds: Set<string>;
          try {
            const sessions = await listAgentSessions(session_id);
            recoveredSessionIds = new Set(sessions.map((s) => s.sessionId));
            frontendLog(
              "disconnect",
              `agent connected: ${recoveredSessionIds.size} sessions recovered: [${[...recoveredSessionIds].join(", ")}]`
            );
          } catch (err) {
            // Can't reach the agent — assume all sessions are gone (safe fallback).
            recoveredSessionIds = new Set();
            frontendLog(
              "disconnect",
              `agent connected: failed to list sessions (${err}), assuming all gone`
            );
          }

          // Transition each reconnecting tab based on whether its session survived.
          let markedResumed = 0;
          let markedExited = 0;
          for (const tab of agentTerminalTabs) {
            if (!store.terminalReconnectingTabs[tab.id]) continue;
            if (tab.sessionId && recoveredSessionIds.has(tab.sessionId)) {
              // Session survived — clear the spinner; output will resume automatically.
              frontendLog(
                "disconnect",
                `agent connected: session recovered for tab=${tab.id} session=${tab.sessionId}, resuming`
              );
              store.setTerminalReconnecting(tab.id, false);
              markedResumed++;
            } else {
              // Session is gone — show the "Session disconnected" overlay.
              frontendLog(
                "disconnect",
                `agent connected after reconnect: marking tab=${tab.id} as exited (session not recovered)`
              );
              // Agent lost the session across the reconnect — a dropped session (#1121).
              store.setTerminalExited(tab.id, { code: null, reason: "dropped" });
              markedExited++;
            }
          }
          frontendLog(
            "disconnect",
            `agent connected: ${markedResumed} sessions resumed, ${markedExited} tabs transitioned to exited`
          );

          // Wake any tabs that were parked waiting for this agent to connect.
          // retryTerminalSpawn increments the retry counter, causing the Terminal
          // component's useEffect to re-run and call setupTerminal fresh.
          let wokeCount = 0;
          for (const tab of agentTerminalTabs) {
            if (store.terminalWaitingForAgent[tab.id] === session_id) {
              frontendLog("disconnect", `agent connected: waking waiting tab=${tab.id}`);
              store.setTerminalWaitingForAgent(tab.id, null);
              store.retryTerminalSpawn(tab.id);
              wokeCount++;
            }
          }
          frontendLog("disconnect", `agent connected: woke ${wokeCount} waiting tabs`);

          // Restart tabs that are in the connection-overlay state (auto-retry
          // delay or "Connection failed") for this agent.  These tabs cannot
          // be reached via the reconnecting/waiting paths above because
          // reconnectTerminal cleared terminalReconnectingTabs, and
          // terminalWaitingForAgent is only set when createTerminal fails while
          // the agent is transitioning.  Calling reconnectTerminal cancels the
          // stale retry loop and kicks off a fresh attempt immediately — using
          // the original store snapshot for condition checks to avoid double-
          // waking tabs already handled in the loops above.
          let restartedRetryCount = 0;
          for (const tab of agentTerminalTabs) {
            const hasSpawnError = !!store.terminalSpawnErrors[tab.id];
            const isAutoRetrying = (store.terminalAutoRetryCount[tab.id] ?? 0) > 0;
            const wasWaiting = !!store.terminalWaitingForAgent[tab.id];
            const isConnecting = store.terminalConnecting[tab.id] ?? false;
            if ((hasSpawnError || isAutoRetrying) && !wasWaiting && !isConnecting) {
              frontendLog("disconnect", `agent connected: restarting retry tab=${tab.id}`);
              store.reconnectTerminal(tab.id);
              restartedRetryCount++;
            }
          }
          frontendLog("disconnect", `agent connected: restarted ${restartedRetryCount} retry tabs`);

          store.refreshAgentSessions(session_id);
        } else if (state === "reconnecting") {
          // Show the reconnecting spinner overlay on all tabs with an active
          // session for this agent.
          let markedCount = 0;
          for (const tab of agentTerminalTabs) {
            if (!tab.sessionId) continue;
            frontendLog("disconnect", `agent reconnecting: marking tab=${tab.id}`);
            store.setTerminalReconnecting(tab.id, true);
            if (error) {
              store.setTerminalReconnectTriggerError(tab.id, error);
            }
            markedCount++;
          }
          frontendLog("disconnect", `agent reconnecting: ${markedCount} tabs marked`);
        } else if (state === "disconnected") {
          // Mark all tabs with an active session for this agent as exited so
          // the disconnect overlay appears.
          let markedCount = 0;
          for (const tab of agentTerminalTabs) {
            if (!tab.sessionId) continue;
            frontendLog("disconnect", `agent disconnect: marking tab=${tab.id} as exited`);
            if (error) {
              // Auto-reconnect exhausted its retries — surface the reason.
              store.setTerminalDisconnectWithError(tab.id, error);
            } else {
              // Agent connection dropped without a specific error — a dropped session (#1121).
              store.setTerminalExited(tab.id, { code: null, reason: "dropped" });
            }
            markedCount++;
          }
          frontendLog("disconnect", `agent disconnected: ${markedCount} tabs marked as exited`);
          // Active sessions are gone; clear them so stale entries don't linger.
          // Saved connections (definitions/folders) are kept — they live on disk.
          store.clearAgentSessions(session_id);
        }
      }
    ).then((fn) => {
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
      <TestBridge />
      <div className="terminal-view">
        <div className="terminal-view__toolbar">
          <TabGroupChips />
          <div className="terminal-view__toolbar-actions">
            <Tooltip content="New Terminal" side="bottom">
              <button
                className="terminal-view__toolbar-btn"
                onClick={handleNewTerminal}
                aria-label="New Terminal"
                data-testid="terminal-view-new-terminal"
              >
                <Plus size={16} />
              </button>
            </Tooltip>
            <Tooltip content="Split Terminal Right" side="bottom">
              <button
                className="terminal-view__toolbar-btn"
                onClick={handleSplitHorizontal}
                aria-label="Split Terminal Right"
                data-testid="terminal-view-split-horizontal"
              >
                <Columns2 size={16} />
              </button>
            </Tooltip>
            <Tooltip content="Split Terminal Down" side="bottom">
              <button
                className="terminal-view__toolbar-btn"
                onClick={handleSplitVertical}
                aria-label="Split Terminal Down"
                data-testid="terminal-view-split-vertical"
              >
                <Rows2 size={16} />
              </button>
            </Tooltip>
            {allLeaves.length > 1 && (
              <Tooltip content="Close Panel" side="bottom">
                <button
                  className="terminal-view__toolbar-btn"
                  onClick={handleClosePanel}
                  aria-label="Close Panel"
                  data-testid="terminal-view-close-panel"
                >
                  <X size={16} />
                </button>
              </Tooltip>
            )}
            <Tooltip content={sidebarToggleTitle} side="bottom">
              <button
                className={`terminal-view__toolbar-btn${!sidebarCollapsed ? " terminal-view__toolbar-btn--active" : ""}`}
                onClick={toggleSidebar}
                aria-label={sidebarToggleTitle}
                data-testid="terminal-view-toggle-sidebar"
              >
                <PanelLeft size={16} />
              </button>
            </Tooltip>
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
          persistentConnectionId={tab.persistentConnectionId}
        />
      ))}
    </>
  );
}
