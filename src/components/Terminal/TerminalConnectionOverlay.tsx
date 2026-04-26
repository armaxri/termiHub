import { useCallback } from "react";
import { ServerCrash, RefreshCw, Loader2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import "./TerminalConnectionOverlay.css";

interface TerminalConnectionOverlayProps {
  tabId: string;
  /** Required by closeTab. Available from the panel loop in SplitView. */
  panelId: string;
  tabTitle: string;
  isVisible: boolean;
  /**
   * The effective connection type, e.g. "ssh", "telnet", "serial", "local".
   * For remote-session tabs this should be the inner sessionType.
   * Used to select contextual error hints.
   */
  sessionType?: string;
}

const SSH_AGENT_PATTERN = "Agent auth failed";
const TIMEOUT_PATTERN = "timed out";
const SERIAL_NOT_FOUND_PATTERNS = ["No such file", "cannot find", "not found"];
const SERIAL_PERMISSION_PATTERN = "Permission denied";
const SERIAL_BUSY_PATTERNS = ["busy", "in use", "Access is denied"];

/**
 * Shown over a terminal slot while the backend session is being established.
 *
 * Four states (highest priority first):
 *   waiting-for-agent — parent agent transport still connecting
 *   auto-retrying     — agent session failed, retrying in background
 *   connecting        — createTerminal() is in-flight
 *   failed            — spawn failed; user can retry or cancel
 *
 * Cancel closes the tab via closeTab(tabId, panelId).
 */
export function TerminalConnectionOverlay({
  tabId,
  panelId,
  tabTitle,
  isVisible,
  sessionType = "",
}: TerminalConnectionOverlayProps) {
  const closeTab = useAppStore((s) => s.closeTab);
  const retryTerminalSpawn = useAppStore((s) => s.retryTerminalSpawn);
  const isConnecting = useAppStore((s) => s.terminalConnecting[tabId] ?? false);
  const autoRetryCount = useAppStore((s) => s.terminalAutoRetryCount[tabId] ?? 0);
  const waitingForAgent = useAppStore((s) => s.terminalWaitingForAgent[tabId]);
  const error = useAppStore((s) => s.terminalSpawnErrors[tabId] ?? "");

  const handleCancel = useCallback(() => {
    closeTab(tabId, panelId);
  }, [tabId, panelId, closeTab]);

  const handleRetry = useCallback(() => {
    retryTerminalSpawn(tabId);
  }, [tabId, retryTerminalSpawn]);

  const isSerial = sessionType === "serial";
  const isAgentAuth = error.includes(SSH_AGENT_PATTERN);
  const isTimeout = error.includes(TIMEOUT_PATTERN) && !isAgentAuth;
  const isSerialNotFound = isSerial && SERIAL_NOT_FOUND_PATTERNS.some((p) => error.includes(p));
  const isSerialPermission = isSerial && error.includes(SERIAL_PERMISSION_PATTERN);
  const isSerialBusy =
    isSerial && !isSerialPermission && SERIAL_BUSY_PATTERNS.some((p) => error.includes(p));

  const cls = `terminal-connection-overlay${isVisible ? "" : " terminal-connection-overlay--hidden"}`;

  if (waitingForAgent) {
    return (
      <div className={cls} data-testid="terminal-connection-overlay">
        <div className="terminal-connection-overlay__body">
          <Loader2
            size={32}
            className="terminal-connection-overlay__icon terminal-connection-overlay__icon--spin"
          />
          <p className="terminal-connection-overlay__heading">Waiting for agent…</p>
          <p className="terminal-connection-overlay__subheading">
            Waiting for the agent to connect before starting the session.
          </p>
          <div className="terminal-connection-overlay__actions">
            <button
              className="terminal-connection-overlay__cancel-btn"
              onClick={handleCancel}
              data-testid="terminal-connection-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (autoRetryCount > 0) {
    return (
      <div className={cls} data-testid="terminal-connection-overlay">
        <div className="terminal-connection-overlay__body">
          <Loader2
            size={32}
            className="terminal-connection-overlay__icon terminal-connection-overlay__icon--spin"
          />
          <p className="terminal-connection-overlay__heading">
            Connecting… (attempt {autoRetryCount + 1})
          </p>
          <p className="terminal-connection-overlay__subheading">{tabTitle}</p>
          <div className="terminal-connection-overlay__actions">
            <button
              className="terminal-connection-overlay__cancel-btn"
              onClick={handleCancel}
              data-testid="terminal-connection-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isConnecting) {
    return (
      <div className={cls} data-testid="terminal-connection-overlay">
        <div className="terminal-connection-overlay__body">
          <Loader2
            size={32}
            className="terminal-connection-overlay__icon terminal-connection-overlay__icon--spin"
          />
          <p className="terminal-connection-overlay__heading">Connecting…</p>
          <p className="terminal-connection-overlay__subheading">{tabTitle}</p>
          <div className="terminal-connection-overlay__actions">
            <button
              className="terminal-connection-overlay__cancel-btn"
              onClick={handleCancel}
              data-testid="terminal-connection-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cls} data-testid="terminal-connection-overlay">
      <div className="terminal-connection-overlay__body">
        <ServerCrash size={32} className="terminal-connection-overlay__icon" />

        <p className="terminal-connection-overlay__heading">Connection failed</p>
        <p className="terminal-connection-overlay__subheading">{tabTitle}</p>

        <div className="terminal-connection-overlay__error-box">
          <span className="terminal-connection-overlay__error-text">{error}</span>
        </div>

        {isAgentAuth && (
          <div className="terminal-connection-overlay__hint">
            <p className="terminal-connection-overlay__hint-title">SSH Agent not running</p>
            <p>
              Open the connection editor and use the <strong>Setup SSH Agent</strong> button, or
              run:
            </p>
            <code className="terminal-connection-overlay__hint-code">
              Start-Process powershell -Verb RunAs -ArgumentList &apos;Set-Service ssh-agent
              -StartupType Manual; Start-Service ssh-agent&apos;
            </code>
          </div>
        )}

        {isTimeout && (
          <p className="terminal-connection-overlay__hint-text">
            The connection timed out. Check that the host is reachable and the agent binary is
            installed.
          </p>
        )}

        {isSerialNotFound && (
          <p className="terminal-connection-overlay__hint-text">
            Serial port not found. Check that the device is connected and the port name is correct.
          </p>
        )}

        {isSerialPermission && (
          <div className="terminal-connection-overlay__hint">
            <p className="terminal-connection-overlay__hint-title">Permission denied</p>
            <p>On Linux, add your user to the dialout group and re-login:</p>
            <code className="terminal-connection-overlay__hint-code">
              sudo usermod -aG dialout $USER
            </code>
          </div>
        )}

        {isSerialBusy && (
          <p className="terminal-connection-overlay__hint-text">
            The serial port is already in use by another application.
          </p>
        )}

        <div className="terminal-connection-overlay__actions">
          <button
            className="terminal-connection-overlay__retry-btn"
            onClick={handleRetry}
            data-testid="terminal-connection-retry-btn"
          >
            <RefreshCw size={14} />
            Retry
          </button>
          <button
            className="terminal-connection-overlay__cancel-btn"
            onClick={handleCancel}
            data-testid="terminal-connection-cancel-btn"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
