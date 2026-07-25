import { Component, useEffect } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { TransferQueue } from "@/components/TransferQueue";
import { ShellIntegrationBanner } from "@/components/ShellIntegrationBanner";
import { TerminalView } from "@/components/Terminal";
import { PasswordPrompt } from "@/components/PasswordPrompt";
import { LocalProcessAuthDialog } from "@/components/WorkflowSidebar/LocalProcessAuthDialog";
import { CustomizeLayoutDialog } from "@/components/Settings/CustomizeLayoutDialog";
import { ExportDialog, ImportDialog } from "@/components/ExportImport";
import { UnlockDialog } from "@/components/UnlockDialog";
import { SpawnPicker } from "@/components/Spawn";
import { RecoveryDialog } from "@/components/Settings/RecoveryDialog";
import { ShortcutsOverlay } from "@/components/KeyboardShortcuts/ShortcutsOverlay";
import { CommandPalette } from "@/components/CommandPalette/CommandPalette";
import { OverlayViewPanel } from "@/components/Settings/OverlayViewPanel";
import { LargePasteDialog } from "@/components/Terminal/LargePasteDialog";
import { OpenSavedFileDialog } from "@/components/Terminal/OpenSavedFileDialog";
import { ConfirmCloseTabDialog } from "@/components/Terminal/ConfirmCloseTabDialog";
import { ConfirmSessionCloseDialog } from "@/components/Terminal/ConfirmSessionCloseDialog";
import { SessionRestoreDialog } from "@/components/SessionRestoreDialog";
import { UpdateNotification } from "@/components/UpdateNotification/UpdateNotification";
import { XServerConnectConsent } from "@/components/OpenConnections/XServerConnectConsent";
import { ToastProvider, TooltipProvider } from "@/components/ui";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useTunnelEvents } from "@/hooks/useTunnelEvents";
import { useTransferEvents } from "@/hooks/useTransferEvents";
import { useTransferReconcile } from "@/hooks/useTransferReconcile";
import { useEmbeddedServerEvents } from "@/hooks/useEmbeddedServerEvents";
import { useCredentialStoreEvents } from "@/hooks/useCredentialStoreEvents";
import { useAgentUpdateEvents } from "@/hooks/useAgentUpdateEvents";
import { useAgentUpdatePendingEvents } from "@/hooks/useAgentUpdatePendingEvents";
import { useSpawnChoiceHandler, useSpawnRequests } from "@/hooks/useSpawnRequests";
import { useHttpMonitorNotifications } from "@/hooks/useHttpMonitorNotifications";
import { useWebviewZoom } from "@/hooks/useWebviewZoom";
import { useSidebarResize } from "@/hooks/useSidebarResize";
import { useAppStore } from "@/store/appStore";
import { getCliWorkspace } from "@/services/workspaceApi";
import { resolveRestoreMode } from "@/utils/restoreMode";
import { MAIN_WINDOW_LABEL } from "@/types/window";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches unhandled React rendering errors and displays them instead of
 * showing a blank grey screen.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("React render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            color: "var(--color-error)",
            background: "var(--bg-primary)",
            fontFamily: "monospace",
            height: "100%",
            overflow: "auto",
          }}
        >
          <h2 style={{ color: "var(--text-primary)" }}>Something went wrong</h2>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{this.state.error.message}</pre>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              marginTop: 8,
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            {this.state.error.stack}
          </pre>
          <button
            style={{
              marginTop: 16,
              padding: "6px 16px",
              background: "var(--accent-color)",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  useKeyboardShortcuts();
  useTunnelEvents();
  useTransferEvents();
  useTransferReconcile();
  useEmbeddedServerEvents();
  useCredentialStoreEvents();
  useAgentUpdateEvents();
  useAgentUpdatePendingEvents();
  useSpawnRequests();
  useHttpMonitorNotifications();
  useWebviewZoom();
  const loadFromBackend = useAppStore((s) => s.loadFromBackend);
  const checkForUpdates = useAppStore((s) => s.checkForUpdates);
  const settings = useAppStore((s) => s.settings);
  const layoutConfig = useAppStore((s) => s.layoutConfig);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const { sidebarWidth, handleProps, isResizing } = useSidebarResize(layoutConfig.sidebarPosition);
  const unlockDialogOpen = useAppStore((s) => s.unlockDialogOpen);
  const setUnlockDialogOpen = useAppStore((s) => s.setUnlockDialogOpen);
  const spawnPickerVisible = useAppStore((s) => s.spawnPickerVisible);
  const spawnPickerRequest = useAppStore((s) => s.spawnPickerRequest);
  const hideSpawnPicker = useAppStore((s) => s.hideSpawnPicker);
  const handleSpawnChoice = useSpawnChoiceHandler();
  const recoveryWarnings = useAppStore((s) => s.recoveryWarnings);
  const recoveryDialogOpen = useAppStore((s) => s.recoveryDialogOpen);
  const setRecoveryDialogOpen = useAppStore((s) => s.setRecoveryDialogOpen);
  const shortcutsOverlayOpen = useAppStore((s) => s.shortcutsOverlayOpen);
  const setShortcutsOverlayOpen = useAppStore((s) => s.setShortcutsOverlayOpen);
  const largePasteDialog = useAppStore((s) => s.largePasteDialog);
  const closeLargePasteDialog = useAppStore((s) => s.closeLargePasteDialog);
  const openSavedFileDialog = useAppStore((s) => s.openSavedFileDialog);
  const closeOpenSavedFileDialog = useAppStore((s) => s.closeOpenSavedFileDialog);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const openEditorTab = useAppStore((s) => s.openEditorTab);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    // Auto-save the open tabs/layout whenever the panel tree changes, so the
    // session can be restored after a reload or restart. Attached only after the
    // initial restore so restoring does not immediately re-save.
    const enableAutoSave = () => {
      unsubscribe = useAppStore.subscribe((state, prevState) => {
        if (
          state.tabGroups !== prevState.tabGroups ||
          state.rootPanel !== prevState.rootPanel ||
          state.activePanelId !== prevState.activePanelId ||
          state.activeTabGroupId !== prevState.activeTabGroupId
        ) {
          state.scheduleLastSessionSave();
        }
      });
    };

    (async () => {
      await loadFromBackend();

      // Secondary windows (#1900) boot empty: they never restore the main
      // window's last session and never auto-save (window-dimension persistence
      // is #1905). Instead they drain any tabs handed off to them. Live moves to
      // an already-open window arrive via the `window-handoff` listener below.
      const isMainWindow = getCurrentWindow().label === MAIN_WINDOW_LABEL;
      if (!isMainWindow) {
        await useAppStore.getState().receivePendingHandoffs();
        return;
      }

      // A workspace launched from the CLI takes precedence over the last session.
      let handledByCli = false;
      try {
        const cliWorkspaceName = await getCliWorkspace();
        if (cliWorkspaceName) {
          const { workspaces, launchWorkspace } = useAppStore.getState();
          const ws = workspaces.find(
            (w) => w.name.toLowerCase() === cliWorkspaceName.toLowerCase()
          );
          if (ws) {
            await launchWorkspace(ws.id);
            handledByCli = true;
          }
        }
      } catch {
        // CLI plugin not available (e.g., browser dev mode)
      }

      const store = useAppStore.getState();
      const restoreMode = resolveRestoreMode(store.settings);
      if (restoreMode === "never") {
        // Never restore: drop any stale stored session from a previous run.
        await store.clearLastSession();
      } else if (!handledByCli) {
        if (restoreMode === "always") {
          await store.restoreLastSession();
        } else {
          // "ask": raise the restore dialog when a session is stored.
          await store.promptRestore();
        }
      }

      // Always observe layout changes; saveLastSession itself honors the current
      // setting, so toggling it at runtime takes effect without a restart.
      enableAutoSave();
    })();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [loadFromBackend]);

  // Reload connections whenever this window regains focus so that changes made
  // in a parallel instance (add, delete, rename) are immediately visible here.
  // Uses the versioned reload guard so a stale focus reload cannot override a
  // more recent mutation's correction.
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        useAppStore.getState().reloadConnectionsFromBackend();
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Reload connections when another running instance modifies connections.json.
  // The backend polls the file's mtime every second and emits this event on change.
  useEffect(() => {
    const unlistenPromise = listen<void>("connections-changed", () => {
      useAppStore.getState().reloadConnectionsFromBackend();
    });
    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Multi-window (#1900): a tab moved into an already-open window arrives as a
  // queued hand-off plus a global `window-handoff` nudge. Every window drains
  // its own queue; only the targeted window has a record, so the rest no-op.
  useEffect(() => {
    const unlistenPromise = listen<void>("window-handoff", () => {
      void useAppStore.getState().receivePendingHandoffs();
    });
    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Schedule update check: 5-second delay on startup, then every 24 hours.
  useEffect(() => {
    if (!settings.updates?.autoCheck && settings.updates?.autoCheck !== undefined) return;
    const STARTUP_DELAY_MS = 5000;
    const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const startupTimer = setTimeout(() => checkForUpdates(false), STARTUP_DELAY_MS);
    const periodicTimer = setInterval(() => checkForUpdates(false), CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(startupTimer);
      clearInterval(periodicTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Suppress the browser's default context menu globally so only custom
  // Radix UI context menus appear on right-click.
  useEffect(() => {
    const suppress = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", suppress);
    return () => window.removeEventListener("contextmenu", suppress);
  }, []);

  return (
    <ErrorBoundary>
      <TooltipProvider>
        <div className="app">
          {layoutConfig.activityBarPosition === "top" && <ActivityBar horizontal />}
          <div className={`app__main app__main--ab-${layoutConfig.activityBarPosition}`}>
            {layoutConfig.activityBarPosition === "left" && <ActivityBar />}
            {layoutConfig.sidebarPosition === "left" && layoutConfig.sidebarVisible && (
              <>
                <Sidebar width={sidebarWidth} />
                {!sidebarCollapsed && (
                  <div
                    className={`sidebar-resize-handle${isResizing ? " sidebar-resize-handle--active" : ""}`}
                    data-testid="sidebar-resize-handle"
                    {...handleProps}
                  />
                )}
              </>
            )}
            <TerminalView />
            {layoutConfig.sidebarPosition === "right" && layoutConfig.sidebarVisible && (
              <>
                {!sidebarCollapsed && (
                  <div
                    className={`sidebar-resize-handle${isResizing ? " sidebar-resize-handle--active" : ""}`}
                    data-testid="sidebar-resize-handle"
                    {...handleProps}
                  />
                )}
                <Sidebar width={sidebarWidth} />
              </>
            )}
            {layoutConfig.activityBarPosition === "right" && <ActivityBar />}
          </div>
          <ShellIntegrationBanner />
          <TransferQueue />
          {layoutConfig.statusBarVisible && <StatusBar />}
          <PasswordPrompt />
          <LocalProcessAuthDialog />
          <CustomizeLayoutDialog />
          <ExportDialog />
          <ImportDialog />
          <UnlockDialog open={unlockDialogOpen} onOpenChange={setUnlockDialogOpen} />
          <SpawnPicker
            open={spawnPickerVisible}
            location={spawnPickerRequest?.location}
            defaultNewWindow={spawnPickerRequest?.new_window ?? false}
            onConfirm={(choice) => {
              const request = spawnPickerRequest;
              hideSpawnPicker();
              if (request) void handleSpawnChoice(request, choice);
            }}
            onCancel={hideSpawnPicker}
          />
          <RecoveryDialog
            open={recoveryDialogOpen}
            onOpenChange={setRecoveryDialogOpen}
            warnings={recoveryWarnings}
          />
          <ShortcutsOverlay open={shortcutsOverlayOpen} onOpenChange={setShortcutsOverlayOpen} />
          <CommandPalette />
          <OverlayViewPanel />
          <LargePasteDialog
            open={largePasteDialog.open}
            charCount={largePasteDialog.charCount}
            onConfirm={() => {
              largePasteDialog.onConfirm?.();
              closeLargePasteDialog();
            }}
            onCancel={closeLargePasteDialog}
          />
          <OpenSavedFileDialog
            open={openSavedFileDialog.open}
            filePath={openSavedFileDialog.filePath}
            askAgain={settings.askOpenSavedFileInTab ?? true}
            onAskAgainChange={(askAgain) =>
              updateSettings({ ...settings, askOpenSavedFileInTab: askAgain })
            }
            onOpen={() => {
              openEditorTab(openSavedFileDialog.filePath, false);
              closeOpenSavedFileDialog();
            }}
            onCancel={closeOpenSavedFileDialog}
          />
          <UpdateNotification />
          <ConfirmCloseTabDialog />
          <ConfirmSessionCloseDialog />
          <SessionRestoreDialog />
          <XServerConnectConsent />
          <ToastProvider />
        </div>
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
