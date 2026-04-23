import { useCallback } from "react";
import { WifiOff, RefreshCw, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import "./TerminalDisconnectOverlay.css";

interface TerminalDisconnectOverlayProps {
  tabId: string;
}

/**
 * Shown as an absolute overlay on top of the terminal content when the session
 * exits unexpectedly (e.g. remote host reboots). Preserves the scrollback buffer
 * behind the overlay. The reconnect button triggers a fresh session using the
 * same connection config; the dismiss button hides the overlay without reconnecting.
 */
export function TerminalDisconnectOverlay({ tabId }: TerminalDisconnectOverlayProps) {
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  const dismissTerminalDisconnect = useAppStore((s) => s.dismissTerminalDisconnect);

  const handleReconnect = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  const handleDismiss = useCallback(() => {
    dismissTerminalDisconnect(tabId);
  }, [tabId, dismissTerminalDisconnect]);

  return (
    <div className="terminal-disconnect-overlay" data-testid="terminal-disconnect-overlay">
      <button
        className="terminal-disconnect-overlay__dismiss"
        onClick={handleDismiss}
        title="Dismiss"
        aria-label="Dismiss disconnect overlay"
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

        <button
          className="terminal-disconnect-overlay__reconnect-btn"
          onClick={handleReconnect}
          data-testid="terminal-disconnect-reconnect-btn"
        >
          <RefreshCw size={14} />
          Reconnect
        </button>
      </div>
    </div>
  );
}
