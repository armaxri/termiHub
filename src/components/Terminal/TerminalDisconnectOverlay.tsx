import { useCallback } from "react";
import { WifiOff, RefreshCw, X, AlertTriangle, Loader2, CheckCircle2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, Tooltip } from "@/components/ui";
import type { TerminalExitInfo } from "@/types/terminal";
import "./TerminalDisconnectOverlay.css";

interface TerminalDisconnectOverlayProps {
  tabId: string;
}

/** Heading + subheading shown in the default (disconnected) overlay variant. */
interface DisconnectCopy {
  heading: string;
  subheading: string;
  /** When true, render the calmer clean-exit icon instead of the WifiOff icon. */
  clean: boolean;
}

/**
 * Derive the overlay's heading/subheading from how the session ended (#1121).
 * Without exit info we fall back to the legacy generic wording.
 */
function disconnectCopyFor(info: TerminalExitInfo | undefined): DisconnectCopy {
  if (info?.reason === "clean") {
    const codeSuffix = info.code === null ? "" : ` (exit code ${info.code})`;
    return {
      heading: "Session ended",
      subheading: `The session ended normally${codeSuffix}. Scrollback is preserved below.`,
      clean: true,
    };
  }

  if (info?.reason === "dropped") {
    const subheading =
      info.code === null
        ? "The connection was lost. Scrollback is preserved below."
        : `The remote process exited unexpectedly (exit code ${info.code}). Scrollback is preserved below.`;
    return { heading: "Session disconnected", subheading, clean: false };
  }

  // Legacy fallback: no exit info was recorded.
  return {
    heading: "Session disconnected",
    subheading: "The remote process has exited. Scrollback is preserved below.",
    clean: false,
  };
}

/**
 * Shown as an absolute overlay on top of the terminal content when the session
 * exits unexpectedly or while the agent is auto-reconnecting.
 *
 * Three variants (determined from store state):
 *   - "reconnecting"  — spinner, optional trigger error, Stop button
 *   - "error"         — error box, "Reconnect failed" heading, retry + view-scrollback buttons
 *   - "disconnected"  — standard disconnect, reconnect + view-scrollback buttons
 *
 * The scrollback buffer is always preserved below the overlay.
 */
export function TerminalDisconnectOverlay({ tabId }: TerminalDisconnectOverlayProps) {
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  const dismissTerminalDisconnect = useAppStore((s) => s.dismissTerminalDisconnect);
  const setTerminalExited = useAppStore((s) => s.setTerminalExited);
  const disconnectError = useAppStore((s) => s.terminalDisconnectErrors[tabId]);
  const isReconnecting = useAppStore((s) => s.terminalReconnectingTabs[tabId] ?? false);
  const reconnectTriggerError = useAppStore((s) => s.terminalReconnectTriggerErrors[tabId]);
  const exitInfo = useAppStore((s) => s.terminalExitInfo[tabId]);

  const handleReconnect = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  const handleDismiss = useCallback(() => {
    dismissTerminalDisconnect(tabId);
  }, [tabId, dismissTerminalDisconnect]);

  const handleStop = useCallback(() => {
    setTerminalExited(tabId);
  }, [tabId, setTerminalExited]);

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
          {reconnectTriggerError && (
            <div
              className="terminal-disconnect-overlay__error-box"
              data-testid="terminal-disconnect-trigger-error-box"
            >
              <span className="terminal-disconnect-overlay__error-text">
                {reconnectTriggerError}
              </span>
            </div>
          )}
          <div className="terminal-disconnect-overlay__actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleStop}
              data-testid="terminal-disconnect-stop-btn"
            >
              Stop
            </Button>
          </div>
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
        <Tooltip content="View scrollback" side="bottom">
          <button
            className="terminal-disconnect-overlay__dismiss"
            onClick={handleDismiss}
            aria-label="Dismiss and view scrollback"
            data-testid="terminal-disconnect-dismiss-btn"
          >
            <X size={14} />
          </button>
        </Tooltip>

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
            <Button
              variant="primary"
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={handleReconnect}
              data-testid="terminal-disconnect-reconnect-btn"
            >
              Try Again
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleDismiss}
              data-testid="terminal-disconnect-view-btn"
            >
              View Scrollback
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const copy = disconnectCopyFor(exitInfo);

  return (
    <div className="terminal-disconnect-overlay" data-testid="terminal-disconnect-overlay">
      <Tooltip content="View scrollback" side="bottom">
        <button
          className="terminal-disconnect-overlay__dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss disconnect overlay and view scrollback"
          data-testid="terminal-disconnect-dismiss-btn"
        >
          <X size={14} />
        </button>
      </Tooltip>

      <div className="terminal-disconnect-overlay__body">
        {copy.clean ? (
          <CheckCircle2 size={32} className="terminal-disconnect-overlay__icon" />
        ) : (
          <WifiOff size={32} className="terminal-disconnect-overlay__icon" />
        )}

        <p className="terminal-disconnect-overlay__heading">{copy.heading}</p>
        <p className="terminal-disconnect-overlay__subheading">{copy.subheading}</p>

        <div className="terminal-disconnect-overlay__actions">
          <Button
            variant="primary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={handleReconnect}
            data-testid="terminal-disconnect-reconnect-btn"
          >
            Reconnect
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDismiss}
            data-testid="terminal-disconnect-view-btn"
          >
            View Scrollback
          </Button>
        </div>
      </div>
    </div>
  );
}
