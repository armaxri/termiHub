import { useCallback } from "react";
import { WifiOff, RefreshCw, X, AlertTriangle, Loader2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import "./TerminalDisconnectOverlay.css";

interface TerminalDisconnectOverlayProps {
  tabId: string;
}

/**
 * Shown as an absolute overlay on top of the terminal content when the session
 * exits unexpectedly or while the agent is auto-reconnecting.
 *
 * Three variants (determined from store state):
 *   - "reconnecting"  — spinner, "Reconnecting…" message, no user action needed
 *   - "error"         — error box, "Reconnect failed" heading, retry + view-scrollback buttons
 *   - "disconnected"  — standard disconnect, reconnect + view-scrollback buttons
 *
 * The scrollback buffer is always preserved below the overlay.
 */
export function TerminalDisconnectOverlay({ tabId }: TerminalDisconnectOverlayProps) {
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  const dismissTerminalDisconnect = useAppStore((s) => s.dismissTerminalDisconnect);
  const disconnectError = useAppStore((s) => s.terminalDisconnectErrors[tabId]);
  const isReconnecting = useAppStore((s) => s.terminalReconnectingTabs[tabId] ?? false);

  const handleReconnect = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  const handleDismiss = useCallback(() => {
    dismissTerminalDisconnect(tabId);
  }, [tabId, dismissTerminalDisconnect]);

  if (isReconnecting) {
    return (
      <div
        className="terminal-disconnect-overlay terminal-disconnect-overlay--reconnecting"
        data-testid="terminal-disconnect-overlay"
      >
        <div className="terminal-disconnect-overlay__body">
          <Loader2
            size={32}
            className="terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--spin"
          />
          <p className="terminal-disconnect-overlay__heading">Reconnecting…</p>
          <p className="terminal-disconnect-overlay__subheading">
            Connection lost. Attempting to reconnect automatically.
          </p>
        </div>
      </div>
    );
  }

  if (disconnectError) {
    return (
      <div
        className="terminal-disconnect-overlay terminal-disconnect-overlay--error"
        data-testid="terminal-disconnect-overlay"
      >
        <button
          className="terminal-disconnect-overlay__dismiss"
          onClick={handleDismiss}
          title="View scrollback"
          aria-label="Dismiss and view scrollback"
          data-testid="terminal-disconnect-dismiss-btn"
        >
          <X size={14} />
        </button>

        <div className="terminal-disconnect-overlay__body">
          <AlertTriangle
            size={32}
            className="terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--error"
          />

          <p className="terminal-disconnect-overlay__heading">Reconnect failed</p>
          <p className="terminal-disconnect-overlay__subheading">
            All reconnect attempts were exhausted. Scrollback is preserved below.
          </p>

          <div
            className="terminal-disconnect-overlay__error-box"
            data-testid="terminal-disconnect-error-box"
          >
            <span className="terminal-disconnect-overlay__error-text">{disconnectError}</span>
          </div>

          <div className="terminal-disconnect-overlay__actions">
            <button
              className="terminal-disconnect-overlay__reconnect-btn"
              onClick={handleReconnect}
              data-testid="terminal-disconnect-reconnect-btn"
            >
              <RefreshCw size={14} />
              Try Again
            </button>
            <button
              className="terminal-disconnect-overlay__view-btn"
              onClick={handleDismiss}
              data-testid="terminal-disconnect-view-btn"
            >
              View Scrollback
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-disconnect-overlay" data-testid="terminal-disconnect-overlay">
      <button
        className="terminal-disconnect-overlay__dismiss"
        onClick={handleDismiss}
        title="View scrollback"
        aria-label="Dismiss disconnect overlay and view scrollback"
        data-testid="terminal-disconnect-dismiss-btn"
      >
        <X size={14} />
      </button>

      <div className="terminal-disconnect-overlay__body">
        <WifiOff size={32} className="terminal-disconnect-overlay__icon" />

        <p className="terminal-disconnect-overlay__heading">Session disconnected</p>
        <p className="terminal-disconnect-overlay__subheading">
          The remote process has exited. Scrollback is preserved below.
        </p>

        <div className="terminal-disconnect-overlay__actions">
          <button
            className="terminal-disconnect-overlay__reconnect-btn"
            onClick={handleReconnect}
            data-testid="terminal-disconnect-reconnect-btn"
          >
            <RefreshCw size={14} />
            Reconnect
          </button>
          <button
            className="terminal-disconnect-overlay__view-btn"
            onClick={handleDismiss}
            data-testid="terminal-disconnect-view-btn"
          >
            View Scrollback
          </button>
        </div>
      </div>
    </div>
  );
}
