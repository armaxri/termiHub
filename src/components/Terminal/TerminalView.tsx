import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Columns2,
  Rows2,
  X,
  PanelLeft,
  Circle,
  Square,
  Play,
  Radio,
  ScrollText,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useAppStore, getActiveTab } from "@/store/appStore";
import {
  getAllTabsAcrossGroupTrees,
  useActivePanelId,
  useActiveTabGroupId,
  useLayoutRenderTree,
  useLayoutTabGroups,
} from "@/store/layoutSelectors";
import { currentSessionView } from "@/store/sessionBridge";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { useProjectedBroadcast } from "@/store/useProjectedBroadcast";
import { TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import { countLiveSessions } from "@/utils/tabLiveSession";
import { Button, Tooltip } from "@/components/ui";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { TerminalCommandBridge } from "./TerminalCommandBridge";
import { TestBridge } from "@/testbridge/TestBridge";
import { Terminal } from "./Terminal";
import { applyAgentReconnecting } from "./agentStateHandlers";
import { TabGroupChips } from "./TabGroupChips";
import { MacroRecordSaveDialog } from "./MacroRecordSaveDialog";
import { MacroPlaybackDialog } from "./MacroPlaybackDialog";
import { BroadcastScopeDialog } from "./BroadcastScopeDialog";
import { SplitView } from "@/components/SplitView";
import { terminalDispatcher } from "@/services/events";
import {
  listAgentSessions,
  sessionLoggingStart,
  sessionLoggingStop,
  sessionLoggingStatus,
} from "@/services/api";
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

  // Handle backend-reported remote-connection state changes: a "disconnected"
  // state marks the owning tab exited (which drives the per-tab status dot via
  // the tab-id-keyed lifecycle maps — see deriveTabStatus).
  //
  // NOTE (#1123): direct sessions (SSH / telnet / serial) do NOT currently
  // reach this path — the backend never emits `remote-state-change` for them.
  // Their disconnects — including half-open TCP drops (cable pull, NAT timeout,
  // crashed host) — surface via `terminal-exit`: TCP keepalive on the socket
  // (`core::net::enable_tcp_keepalive`) tears the dead connection down, the
  // reader thread sees the error, and `terminal-exit` fires the overlay. This
  // listener is retained as the forward-compatible hook for any future backend
  // that emits explicit `remote-state-change` transitions.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ session_id: string; state: string }>("remote-state-change", (event) => {
      const { session_id, state } = event.payload;
      frontendLog("disconnect", `remote-state-change session=${session_id} state=${state}`);
      useAppStore.getState().setRemoteState(session_id, state);
      if (state === "disconnected") {
        // Find the tab that owns this session and show the disconnect overlay.
        const store = useAppStore.getState();
        const allTabs = getAllTabsAcrossGroupTrees();
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
          state as "disconnected" | "connecting" | "connected" | "reconnecting",
          error
        );

        // Build the full tab list once and reuse across all branches.
        const allTabs = getAllTabsAcrossGroupTrees();

        // Find all terminal tabs that belong to this agent via their connection
        // config. This is more reliable than cross-referencing through
        // agentSessions, which is only populated once on initial connect and
        // therefore empty for sessions opened after the first refresh.
        const agentTerminalTabs = allTabs.filter((tab) => {
          if (tab.contentType !== "terminal") return false;
          const cfg = tab.config.config as { agentId?: string };
          return cfg.agentId === session_id;
        });

        // G5 (#1236): mirror the agent state into the session-id-keyed
        // `remoteStates` map for every active-session tab so the compact
        // tab-strip dot agrees with the terminal overlay. The agent path used
        // to skip this, leaving the dot stale-green through a drop/reconnect.
        for (const tab of agentTerminalTabs) {
          if (tab.sessionId) store.setRemoteState(tab.sessionId, state);
        }

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
          const reconnectingView = currentSessionView();
          for (const tab of agentTerminalTabs) {
            // The shared `session-lifecycle` region is authoritative for the whole
            // transient-break lifecycle (#2555/#2556/#2564) — the same source the
            // overlay + tab dot read — so gate the resume-vs-lost decision on it
            // rather than the local `terminalReconnectingTabs` slice (#2205 PR-B).
            // The backend folds both resolve edges at the source: a recovered
            // session `reconnecting → connected`, a gone session
            // `reconnecting → sessionLost` (#2564). Accept either the mid-break
            // `reconnecting` status or the already-folded `sessionLost` — the
            // backend fold and this handler race, so a gone tab may read either by
            // the time we get here; both mean "this tab was in the break".
            const status = reconnectingView[tab.id]?.status;
            if (status !== "reconnecting" && status !== "sessionLost") continue;
            if (tab.sessionId && recoveredSessionIds.has(tab.sessionId)) {
              // Session survived — the backend `agent_io_task` folds the region
              // entry `reconnecting → connected` at the source (#2556), and output
              // resumes automatically once the region leaves reconnecting. No
              // client fold here (the survived-recovery mirror is retired).
              frontendLog(
                "disconnect",
                `agent connected: session recovered for tab=${tab.id} session=${tab.sessionId}, resuming`
              );
              markedResumed++;
            } else {
              // Session is gone — the backend `agent_io_task` folds the region entry
              // `reconnecting → sessionLost` at the source (#2564), the same
              // authority the "Session lost" overlay renders from (#2512). Reflect
              // only the local presentation view-state here (`terminalExitedTabs`,
              // which mounts the overlay) via `settleSessionLost` — do NOT re-drive
              // the region, which would double-fold against the server authority.
              frontendLog(
                "disconnect",
                `agent connected after reconnect: reflecting server-folded session-lost for tab=${tab.id} (session not recovered)`
              );
              store.settleSessionLost(tab.id);
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
            const isConnecting = currentSessionView()[tab.id]?.status === "connecting";
            if ((hasSpawnError || isAutoRetrying) && !wasWaiting && !isConnecting) {
              frontendLog("disconnect", `agent connected: restarting retry tab=${tab.id}`);
              store.reconnectTerminal(tab.id);
              restartedRetryCount++;
            }
          }
          frontendLog("disconnect", `agent connected: restarted ${restartedRetryCount} retry tabs`);

          // The sessions/definitions refresh is owned by `setAgentConnectionState`
          // (called above for the "connected" transition), so it runs exactly
          // once per connect (G4/#1234) — do not refresh again here.
        } else if (state === "reconnecting") {
          // Live-session tabs show the reconnecting spinner; spawning tabs (no
          // sessionId yet) are parked on the waiting-for-agent path so every
          // agent tab gets honest feedback during a drop (G8, #1242).
          applyAgentReconnecting(session_id, agentTerminalTabs, error);
        } else if (state === "disconnected") {
          // Mark all tabs with an active session for this agent as exited so
          // the disconnect overlay appears.
          let markedCount = 0;
          for (const tab of agentTerminalTabs) {
            if (!tab.sessionId) continue;
            frontendLog("disconnect", `agent disconnect: marking tab=${tab.id} as exited`);
            if (error) {
              // Fully-failed reconnect (#2612/#2564): the backend `agent_io_task` folds
              // the region entry `reconnecting → failed` at the source with the reconnect
              // error (the same authority the "Reconnect failed" overlay reads). Reflect
              // only the local presentation view-state here via `settleBackendReconnectGaveUp`
              // — do NOT re-drive the region (the old `setTerminalDisconnectWithError`
              // `session.connectFailed` mirror was a no-op while the region read
              // `reconnecting`, so the region was left stuck `Reconnecting`); the backend
              // now owns that fold.
              store.settleBackendReconnectGaveUp(tab.id, error);
            } else {
              // Agent connection dropped without a specific error — e.g. a user-initiated
              // agent disconnect. A dropped session (#1121); its region fold stays
              // frontend-owned (out of scope for the fully-failed reconnect edge).
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
  const rootPanel = useLayoutRenderTree();
  const activePanelId = useActivePanelId();
  const removePanel = useAppStore((s) => s.removePanel);
  const setPendingSessionCloseConfirm = useAppStore((s) => s.setPendingSessionCloseConfirm);
  const terminalExitedTabs = useAppStore((s) => s.terminalExitedTabs);
  const terminalSpawnErrors = useAppStore((s) => s.terminalSpawnErrors);
  const confirmCloseLiveSession = useProjectedSettings().confirmCloseLiveSession;
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const macroRecording = useAppStore((s) => s.macroRecording);
  const toggleMacroRecording = useAppStore((s) => s.toggleMacroRecording);
  const macroSaveDialogOpen = useAppStore((s) => s.macroSaveDialogOpen);
  const macroRecordingStepCount = useAppStore((s) => s.macroRecordingSteps.length);
  const saveRecordedMacro = useAppStore((s) => s.saveRecordedMacro);
  const discardRecordedMacro = useAppStore((s) => s.discardRecordedMacro);
  // Render cut (#2242): the toolbar's active/pressed state is sourced from the
  // projected broadcast region when it mirrors appStore, else appStore verbatim.
  const broadcastActive = useProjectedBroadcast().active;
  const stopBroadcast = useAppStore((s) => s.stopBroadcast);
  const macros = useAppStore((s) => s.macros);
  const macroPlayback = useAppStore((s) => s.macroPlayback);
  const playMacro = useAppStore((s) => s.playMacro);
  const cancelMacroPlayback = useAppStore((s) => s.cancelMacroPlayback);
  const [macroPlaybackDialogOpen, setMacroPlaybackDialogOpen] = useState(false);
  const [broadcastDialogOpen, setBroadcastDialogOpen] = useState(false);
  const [broadcastSourceTabId, setBroadcastSourceTabId] = useState<string | null>(null);
  // Session output logging (#1960): the set of session IDs currently logging to
  // a file. The toolbar toggle drives the active terminal's session; the backend
  // is the source of truth, so the active session's state is synced on change.
  const [loggingSessions, setLoggingSessions] = useState<Set<string>>(new Set());
  const activeSessionId = useAppStore((s) => {
    const tab = getActiveTab(s);
    return tab && tab.contentType === "terminal" ? (tab.sessionId ?? null) : null;
  });
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const sidebarToggleTitle = `Toggle Sidebar (${isMac ? "Cmd" : "Ctrl"}+B)`;

  const allLeaves = getAllLeaves(rootPanel);

  // Keep the toggle's pressed state honest when the active terminal changes:
  // logging may have been started elsewhere (per-connection setting) or stopped
  // by the session ending, so re-query the backend for the active session.
  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    sessionLoggingStatus(activeSessionId)
      .then((status) => {
        if (cancelled) return;
        setLoggingSessions((prev) => {
          const isLogging = prev.has(activeSessionId);
          if (!!status === isLogging) return prev;
          const next = new Set(prev);
          if (status) next.add(activeSessionId);
          else next.delete(activeSessionId);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  const isActiveSessionLogging = activeSessionId ? loggingSessions.has(activeSessionId) : false;

  const handleNewTerminal = () => {
    addTab("Terminal", "local");
  };

  // Session output logging toggle (#1960): start/stop writing the active
  // terminal's output to a timestamped file on demand.
  const handleToggleLogging = async () => {
    const tab = getActiveTab(useAppStore.getState());
    if (!tab || tab.contentType !== "terminal" || !tab.sessionId) {
      toast.info("Focus a terminal to log its output");
      return;
    }
    const sid = tab.sessionId;
    if (loggingSessions.has(sid)) {
      try {
        await sessionLoggingStop(sid);
        setLoggingSessions((prev) => {
          const next = new Set(prev);
          next.delete(sid);
          return next;
        });
        toast.success("Stopped session logging");
      } catch (e) {
        toast.error(`Failed to stop logging: ${String(e)}`);
      }
      return;
    }
    try {
      const path = await sessionLoggingStart(sid, undefined, true);
      setLoggingSessions((prev) => new Set(prev).add(sid));
      toast.success(`Logging session output to ${path}`);
    } catch (e) {
      toast.error(`Failed to start logging: ${String(e)}`);
    }
  };

  // Broadcast toggle (#1956): clicking opens the scope-selection dialog (All /
  // Current panel / Custom) rather than starting broadcast directly; a second
  // click while active stops it. The source is the active terminal tab.
  const handleToggleBroadcast = () => {
    if (broadcastActive) {
      stopBroadcast();
      return;
    }
    const source = getActiveTab(useAppStore.getState());
    if (!source || source.contentType !== "terminal") {
      toast.info("Focus a terminal to start broadcasting input");
      return;
    }
    setBroadcastSourceTabId(source.id);
    setBroadcastDialogOpen(true);
  };

  const handleSplitHorizontal = () => {
    splitPanel("horizontal");
  };

  const handleSplitVertical = () => {
    splitPanel("vertical");
  };

  const handleClosePanel = () => {
    if (!activePanelId || allLeaves.length <= 1) return;
    const panel = allLeaves.find((p) => p.id === activePanelId);
    const panelTabs = panel?.tabs ?? [];
    const liveCount = countLiveSessions(panelTabs, {
      terminalExitedTabs,
      terminalSpawnErrors,
    });
    // Confirm before destroying every tab/session in the panel, unless the user
    // opted out or nothing live would be lost.
    if (liveCount > 0 && confirmCloseLiveSession !== false) {
      setPendingSessionCloseConfirm({
        kind: "panel",
        panelId: activePanelId,
        liveCount,
        tabCount: panelTabs.length,
      });
      return;
    }
    removePanel(activePanelId);
  };

  return (
    <TerminalPortalProvider>
      <TerminalCommandBridge />
      <TestBridge />
      <div className="terminal-view">
        <div className="terminal-view__toolbar">
          <TabGroupChips />
          <div className="terminal-view__toolbar-actions">
            <Tooltip content={broadcastActive ? "Stop Broadcast" : "Broadcast Input"} side="bottom">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className={broadcastActive ? "terminal-view__toolbar-action--broadcast" : undefined}
                icon={<Radio size={16} />}
                onClick={handleToggleBroadcast}
                aria-label={broadcastActive ? "Stop Broadcast" : "Broadcast Input"}
                aria-pressed={broadcastActive}
                data-testid="terminal-view-broadcast"
              />
            </Tooltip>
            <Tooltip
              content={isActiveSessionLogging ? "Stop Logging Output" : "Log Session Output"}
              side="bottom"
            >
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className={
                  isActiveSessionLogging ? "terminal-view__toolbar-action--active" : undefined
                }
                icon={<ScrollText size={16} />}
                onClick={() => void handleToggleLogging()}
                aria-label={isActiveSessionLogging ? "Stop Logging Output" : "Log Session Output"}
                aria-pressed={isActiveSessionLogging}
                data-testid="terminal-view-toggle-logging"
              />
            </Tooltip>
            <Tooltip content="New Terminal" side="bottom">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Plus size={16} />}
                onClick={handleNewTerminal}
                aria-label="New Terminal"
                data-testid="terminal-view-new-terminal"
              />
            </Tooltip>
            <Tooltip content="Split Terminal Right" side="bottom">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Columns2 size={16} />}
                onClick={handleSplitHorizontal}
                aria-label="Split Terminal Right"
                data-testid="terminal-view-split-horizontal"
              />
            </Tooltip>
            <Tooltip content="Split Terminal Down" side="bottom">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Rows2 size={16} />}
                onClick={handleSplitVertical}
                aria-label="Split Terminal Down"
                data-testid="terminal-view-split-vertical"
              />
            </Tooltip>
            <Tooltip
              content={macroRecording ? "Stop Recording Macro" : "Record Macro"}
              side="bottom"
            >
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className={macroRecording ? "terminal-view__toolbar-action--recording" : undefined}
                icon={
                  macroRecording ? <Square size={14} fill="currentColor" /> : <Circle size={16} />
                }
                onClick={toggleMacroRecording}
                aria-label={macroRecording ? "Stop Recording Macro" : "Record Macro"}
                aria-pressed={macroRecording}
                data-testid="terminal-view-record-macro"
              />
            </Tooltip>
            <Tooltip
              content={
                macroPlayback
                  ? `Stop Playback (${macroPlayback.played}/${macroPlayback.total})`
                  : "Play Macro"
              }
              side="bottom"
            >
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className={macroPlayback ? "terminal-view__toolbar-action--recording" : undefined}
                icon={macroPlayback ? <Square size={14} fill="currentColor" /> : <Play size={15} />}
                onClick={() =>
                  macroPlayback ? cancelMacroPlayback() : setMacroPlaybackDialogOpen(true)
                }
                aria-label={macroPlayback ? "Stop Macro Playback" : "Play Macro"}
                aria-pressed={macroPlayback !== null}
                data-testid="terminal-view-play-macro"
              />
            </Tooltip>
            {allLeaves.length > 1 && (
              <Tooltip content="Close Panel" side="bottom">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<X size={16} />}
                  onClick={handleClosePanel}
                  aria-label="Close Panel"
                  data-testid="terminal-view-close-panel"
                />
              </Tooltip>
            )}
            <Tooltip content={sidebarToggleTitle} side="bottom">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className={!sidebarCollapsed ? "terminal-view__toolbar-action--active" : undefined}
                icon={<PanelLeft size={16} />}
                onClick={toggleSidebar}
                aria-label={sidebarToggleTitle}
                data-testid="terminal-view-toggle-sidebar"
              />
            </Tooltip>
          </div>
        </div>
        <div className="terminal-view__content" role="region" aria-label="Terminal">
          <TerminalHost />
          <SplitView />
        </div>
      </div>
      <MacroRecordSaveDialog
        open={macroSaveDialogOpen}
        stepCount={macroRecordingStepCount}
        onSave={(meta) => void saveRecordedMacro(meta)}
        onCancel={discardRecordedMacro}
      />
      <MacroPlaybackDialog
        open={macroPlaybackDialogOpen}
        macros={macros}
        onOpenChange={setMacroPlaybackDialogOpen}
        onPlay={(macroId, timingMode) => void playMacro(macroId, { timingMode })}
      />
      <BroadcastScopeDialog
        open={broadcastDialogOpen}
        onOpenChange={setBroadcastDialogOpen}
        sourceTabId={broadcastSourceTabId}
      />
    </TerminalPortalProvider>
  );
}

/**
 * Renders ALL terminal instances across ALL tab groups in a stable location
 * in the React tree. Terminal components create imperative DOM elements that
 * are adopted by TerminalSlot components in panels — this prevents
 * unmount/remount when tabs move between panels or groups, preserving PTY
 * sessions and terminal content.
 *
 * Exported for the layout-scrollback regression suite
 * (`TerminalView.layout-scrollback.test.tsx`), which asserts this keyed list
 * never remounts a surviving terminal across a structural layout op — the
 * render-path guarantee that a tab's live xterm (and its scrollback) survives
 * split / move / merge / group ops.
 */
export function TerminalHost() {
  const rootPanel = useLayoutRenderTree();
  const tabGroups = useLayoutTabGroups();
  const activeTabGroupId = useActiveTabGroupId();

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
          spawned={tab.spawned}
          replayScrollbackOnAttach={tab.pendingScrollbackReplay}
        />
      ))}
    </>
  );
}
