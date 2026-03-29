import { Component, useEffect } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { TerminalView } from "@/components/Terminal";
import { PasswordPrompt } from "@/components/PasswordPrompt";
import { CustomizeLayoutDialog } from "@/components/Settings/CustomizeLayoutDialog";
import { ExportDialog, ImportDialog } from "@/components/ExportImport";
import { UnlockDialog } from "@/components/UnlockDialog";
import { MasterPasswordSetup } from "@/components/MasterPasswordSetup";
import { RecoveryDialog } from "@/components/Settings/RecoveryDialog";
import { ShortcutsOverlay } from "@/components/KeyboardShortcuts/ShortcutsOverlay";
import { LargePasteDialog } from "@/components/Terminal/LargePasteDialog";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useTunnelEvents } from "@/hooks/useTunnelEvents";
import { useEmbeddedServerEvents } from "@/hooks/useEmbeddedServerEvents";
import { useCredentialStoreEvents } from "@/hooks/useCredentialStoreEvents";
import { useWebviewZoom } from "@/hooks/useWebviewZoom";
import { useSidebarResize } from "@/hooks/useSidebarResize";
import { useAppStore } from "@/store/appStore";
import { getCliWorkspace } from "@/services/workspaceApi";
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
  useEmbeddedServerEvents();
  useCredentialStoreEvents();
  useWebviewZoom();
  const loadFromBackend = useAppStore((s) => s.loadFromBackend);
  const layoutConfig = useAppStore((s) => s.layoutConfig);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const { sidebarWidth, handleProps, isResizing } = useSidebarResize(layoutConfig.sidebarPosition);
  const unlockDialogOpen = useAppStore((s) => s.unlockDialogOpen);
  const setUnlockDialogOpen = useAppStore((s) => s.setUnlockDialogOpen);
  const masterPasswordSetupOpen = useAppStore((s) => s.masterPasswordSetupOpen);
  const masterPasswordSetupMode = useAppStore((s) => s.masterPasswordSetupMode);
  const closeMasterPasswordSetup = useAppStore((s) => s.closeMasterPasswordSetup);
  const recoveryWarnings = useAppStore((s) => s.recoveryWarnings);
  const recoveryDialogOpen = useAppStore((s) => s.recoveryDialogOpen);
  const setRecoveryDialogOpen = useAppStore((s) => s.setRecoveryDialogOpen);
  const shortcutsOverlayOpen = useAppStore((s) => s.shortcutsOverlayOpen);
  const setShortcutsOverlayOpen = useAppStore((s) => s.setShortcutsOverlayOpen);
  const largePasteDialog = useAppStore((s) => s.largePasteDialog);
  const closeLargePasteDialog = useAppStore((s) => s.closeLargePasteDialog);

  useEffect(() => {
    (async () => {
      await loadFromBackend();
      try {
        const cliWorkspaceName = await getCliWorkspace();
        if (cliWorkspaceName) {
          const { workspaces, launchWorkspace } = useAppStore.getState();
          const ws = workspaces.find(
            (w) => w.name.toLowerCase() === cliWorkspaceName.toLowerCase()
          );
          if (ws) {
            launchWorkspace(ws.id);
          }
        }
      } catch {
        // CLI plugin not available (e.g., browser dev mode)
      }
    })();
  }, [loadFromBackend]);

  // Suppress the browser's default context menu globally so only custom
  // Radix UI context menus appear on right-click.
  useEffect(() => {
    const suppress = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", suppress);
    return () => window.removeEventListener("contextmenu", suppress);
  }, []);

  return (
    <ErrorBoundary>
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
        {layoutConfig.statusBarVisible && <StatusBar />}
        <PasswordPrompt />
        <CustomizeLayoutDialog />
        <ExportDialog />
        <ImportDialog />
        <UnlockDialog open={unlockDialogOpen} onOpenChange={setUnlockDialogOpen} />
        <MasterPasswordSetup
          open={masterPasswordSetupOpen}
          onOpenChange={(open) => {
            if (!open) closeMasterPasswordSetup();
          }}
          mode={masterPasswordSetupMode}
        />
        <RecoveryDialog
          open={recoveryDialogOpen}
          onOpenChange={setRecoveryDialogOpen}
          warnings={recoveryWarnings}
        />
        <ShortcutsOverlay open={shortcutsOverlayOpen} onOpenChange={setShortcutsOverlayOpen} />
        <LargePasteDialog
          open={largePasteDialog.open}
          charCount={largePasteDialog.charCount}
          onConfirm={() => {
            largePasteDialog.onConfirm?.();
            closeLargePasteDialog();
          }}
          onCancel={closeLargePasteDialog}
        />
      </div>
    </ErrorBoundary>
  );
}

export default App;
