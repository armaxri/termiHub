import { useState, useCallback } from "react";
import { ServerCrash, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import "./TerminalSpawnErrorOverlay.css";

interface TerminalSpawnErrorOverlayProps {
  tabId: string;
  error: string;
  tabTitle: string;
  isVisible: boolean;
}

const SSH_AGENT_PATTERN = "Agent auth failed";
const TIMEOUT_PATTERN = "timed out";

/**
 * Shown over a terminal slot when the PTY spawn fails.
 * The retry button increments the terminal's retry counter, causing the
 * Terminal component to tear down the failed xterm and start a fresh attempt.
 */
export function TerminalSpawnErrorOverlay({
  tabId,
  error,
  tabTitle,
  isVisible,
}: TerminalSpawnErrorOverlayProps) {
  const [retrying, setRetrying] = useState(false);
  const retryTerminalSpawn = useAppStore((s) => s.retryTerminalSpawn);

  const handleRetry = useCallback(() => {
    setRetrying(true);
    retryTerminalSpawn(tabId);
  }, [tabId, retryTerminalSpawn]);

  const isAgentAuth = error.includes(SSH_AGENT_PATTERN);
  const isTimeout = error.includes(TIMEOUT_PATTERN);

  return (
    <div
      className={`terminal-spawn-error${isVisible ? "" : " terminal-spawn-error--hidden"}`}
      data-testid="terminal-spawn-error-overlay"
    >
      <div className="terminal-spawn-error__body">
        <ServerCrash size={32} className="terminal-spawn-error__icon" />

        <p className="terminal-spawn-error__heading">Connection Failed</p>
        <p className="terminal-spawn-error__subheading">{tabTitle}</p>

        <div className="terminal-spawn-error__error-box">
          <span className="terminal-spawn-error__error-text">{error}</span>
        </div>

        {isAgentAuth && (
          <div className="terminal-spawn-error__hint">
            <p className="terminal-spawn-error__hint-title">SSH Agent not running</p>
            <p>
              Open the connection editor and use the <strong>Setup SSH Agent</strong> button, or
              run:
            </p>
            <code className="terminal-spawn-error__hint-code">
              Start-Process powershell -Verb RunAs -ArgumentList &apos;Set-Service ssh-agent
              -StartupType Manual; Start-Service ssh-agent&apos;
            </code>
          </div>
        )}

        {isTimeout && !isAgentAuth && (
          <p className="terminal-spawn-error__hint-text">
            The remote agent did not respond in time. Check that the host is reachable and the agent
            binary is installed.
          </p>
        )}

        <div className="terminal-spawn-error__actions">
          <button
            className="terminal-spawn-error__retry-btn"
            onClick={handleRetry}
            disabled={retrying}
            data-testid="terminal-spawn-error-retry-btn"
          >
            <RefreshCw size={14} className={retrying ? "terminal-spawn-error__spin" : ""} />
            {retrying ? "Connecting…" : "Retry"}
          </button>
        </div>
      </div>
    </div>
  );
}
