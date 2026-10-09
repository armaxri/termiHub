import { useCallback } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button } from "@/components/ui";
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
  // The user disconnected or shut down this tab's agent (#4309): say so, since
  // Reconnect will bring the agent back before starting a new session.
  const agentDisconnected = useAppStore((s) => s.terminalAgentDisconnected[tabId] ?? false);

  const handleReconnect = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  return (
    <div className="terminal-view-mode-banner" data-testid="terminal-view-mode-banner">
      <WifiOff size={12} className="terminal-view-mode-banner__icon" />
      <span className="terminal-view-mode-banner__label">
        {agentDisconnected
          ? "Agent disconnected — press Enter or click Reconnect to reconnect it and start a new session"
          : "Session ended — press Enter or click Reconnect to start a new session"}
      </span>
      <Button
        variant="primary"
        size="sm"
        icon={<RefreshCw size={11} />}
        onClick={handleReconnect}
        data-testid="terminal-view-mode-reconnect-btn"
      >
        Reconnect
      </Button>
    </div>
  );
}
