import { lazy, Suspense, useEffect, useMemo, useState } from "react";
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
import { useAppStore, getActiveTab } from "@/store/appStore";
import {
  useActivePanelId,
  useActiveTabGroupId,
  useLayoutRenderTree,
  useLayoutTabGroups,
} from "@/store/layoutSelectors";
import { useProjectedBroadcast } from "@/store/useProjectedBroadcast";
import { TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import { closePanelGuarded } from "@/utils/tabGroupCloseGuard";
import { Button, Tooltip, toast } from "@/components/ui";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { TerminalCommandBridge } from "./TerminalCommandBridge";
import { Terminal } from "./Terminal";
import {
  handleAgentStateChange,
  handleRemoteStateChange,
  type AgentStateChangePayload,
  type RemoteStateChangePayload,
} from "./agentStateHandlers";
import { TabGroupChips } from "./TabGroupChips";
import { MacroRecordSaveDialog } from "./MacroRecordSaveDialog";
import { MacroPlaybackDialog } from "./MacroPlaybackDialog";
import { BroadcastScopeDialog } from "./BroadcastScopeDialog";
import { SplitView } from "@/components/SplitView";
import { terminalDispatcher } from "@/services/events";
import { sessionLoggingStart, sessionLoggingStop, sessionLoggingStatus } from "@/services/api";
import { errorMessage } from "@/utils/errorMessage";
import "./TerminalView.css";

/**
 * The in-app test bridge, included ONLY in test/E2E builds (TIN-003).
 *
 * `import.meta.env.VITE_TEST_BRIDGE` is a build-time constant: Vite inlines it,
 * so in a production build (no `VITE_TEST_BRIDGE=1`) this ternary folds to a
 * literal `false ? … : null` and Rollup tree-shakes the guarded dynamic
 * `import()` — the entire `@/testbridge/*` dispatcher is dropped from the
 * shipped bundle rather than merely dormant. The backend `test-bridge` cargo
 * feature gates the same surface out of release binaries; the harness build
 * (`scripts/test-system-py.sh`) sets `VITE_TEST_BRIDGE=1`, which restores it.
 *
 * A runtime `if` would NOT tree-shake — the guard must be this build-time
 * constant around a dynamic import for the module to be statically eliminated.
 */
const LazyTestBridge =
  import.meta.env.VITE_TEST_BRIDGE === "1"
    ? lazy(() => import("@/testbridge/TestBridge").then((m) => ({ default: m.TestBridge })))
    : null;

export function TerminalView() {
  // Initialize the singleton event dispatcher once.
  // No cleanup — the dispatcher is a module-level singleton that persists for
  // the app's lifetime. Per-session subscriptions handle individual terminal
  // lifecycle. Avoiding destroy() here prevents an async race condition under
  // React StrictMode where duplicate Tauri listeners cause doubled output.
  useEffect(() => {
    terminalDispatcher.init();
  }, []);

  // Backend state-change events. The handlers live in `agentStateHandlers` so
  // tests drive the real code (TFE2-001): `remote-state-change` marks a dropped
  // remote session's tab exited; `agent-state-change` updates the agent's state
  // (sidebar dots) and moves its hosted tabs — resume, session-lost, reconnect,
  // or a clean end after a user Disconnect/Shutdown (#4309).
  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    let disposed = false;
    const keep = (fn: () => void) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };
    void listen<RemoteStateChangePayload>("remote-state-change", (event) =>
      handleRemoteStateChange(event.payload)
    ).then(keep);
    void listen<AgentStateChangePayload>("agent-state-change", (event) =>
      handleAgentStateChange(event.payload)
    ).then(keep);
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const addTab = useAppStore((s) => s.addTab);
  const splitPanel = useAppStore((s) => s.splitPanel);
  const rootPanel = useLayoutRenderTree();
  const activePanelId = useActivePanelId();
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
        toast.error(`Failed to stop logging: ${errorMessage(e)}`);
      }
      return;
    }
    try {
      const path = await sessionLoggingStart(sid, undefined, true);
      setLoggingSessions((prev) => new Set(prev).add(sid));
      toast.success(`Logging session output to ${path}`);
    } catch (e) {
      toast.error(`Failed to start logging: ${errorMessage(e)}`);
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
    // Confirms first when the panel holds live sessions or unsaved editors
    // (UX2-003), so removing it never silently discards work.
    closePanelGuarded(activePanelId);
  };

  return (
    <TerminalPortalProvider>
      <TerminalCommandBridge />
      {LazyTestBridge && (
        <Suspense fallback={null}>
          <LazyTestBridge />
        </Suspense>
      )}
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
        onPlay={(macroId, timingMode, targetTabIds) =>
          void playMacro(macroId, { timingMode, targetTabIds })
        }
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

  const { allTabs, onScreenTabIds } = useMemo(() => {
    // Active group: use live rootPanel (always up-to-date)
    const activeTabs = getAllLeaves(rootPanel)
      .flatMap((leaf) => leaf.tabs)
      .filter((tab) => tab.contentType === "terminal");

    // Inactive groups: use saved rootPanel from tabGroups store
    const inactiveTabs = tabGroups
      .filter((g) => g.id !== activeTabGroupId)
      .flatMap((g) => getAllLeaves(g.rootPanel).flatMap((leaf) => leaf.tabs))
      .filter((tab) => tab.contentType === "terminal");

    // Only the active group's panel-active tabs are on screen; saved panels of
    // other groups keep `isActive` but must not hold a WebGL context (#4308).
    const onScreen = new Set(activeTabs.filter((tab) => tab.isActive).map((tab) => tab.id));
    // #4434: a tab held on an unconfirmed imported inline config must not
    // connect, so no Terminal (and no session) exists for it until confirmed.
    const tabs: TerminalTab[] = [...activeTabs, ...inactiveTabs].filter(
      (tab) => !tab.pendingImportedConnection
    );
    return { allTabs: tabs, onScreenTabIds: onScreen };
  }, [rootPanel, tabGroups, activeTabGroupId]);

  return (
    <>
      {allTabs.map((tab) => (
        <Terminal
          key={tab.id}
          tabId={tab.id}
          config={tab.config}
          isVisible={tab.isActive}
          isOnScreen={onScreenTabIds.has(tab.id)}
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
