import { useCallback } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import "./TerminalViewModeBanner.css";

interface TerminalViewModeBannerProps {
  tabId: string;
}

/**
 * Thin non-blocking banner rendered at the bottom of the terminal slot when the
 * disconnect overlay has been dismissed and the user is browsing the scrollback.
 * Keeps the terminal fully interactive for selection and copy while clearly
 * marking the session as dead.
 */
export function TerminalViewModeBanner({ tabId }: TerminalViewModeBannerProps) {
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);

  const handleReconnect = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  return (
    <div className="terminal-view-mode-banner" data-testid="terminal-view-mode-banner">
      <WifiOff size={12} className="terminal-view-mode-banner__icon" />
      <span className="terminal-view-mode-banner__label">
        Session ended — press Enter or click Reconnect to start a new session
      </span>
      <button
        className="terminal-view-mode-banner__reconnect-btn"
        onClick={handleReconnect}
        data-testid="terminal-view-mode-reconnect-btn"
      >
        <RefreshCw size={11} />
        Reconnect
      </button>
    </div>
  );
}
