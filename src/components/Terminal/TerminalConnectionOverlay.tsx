import { useCallback, useEffect } from "react";
import { ServerCrash, RefreshCw, Loader2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useElapsed } from "@/hooks/useElapsed";
import { frontendLog } from "@/utils/frontendLog";
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

/** Seconds after which a still-pending connect is flagged as unusually slow. */
const SLOW_CONNECT_THRESHOLD_SECONDS = 20;

/**
 * Client-side deadline for a plain `Connecting` attempt (#1129).
 *
 * The backend connect itself is bounded (the default SSH connect timeout is
 * 20 s, see `DEFAULT_SSH_CONNECT_TIMEOUT_SECS`), so this is a safety net set
 * comfortably above it: it only fires if the backend hangs past its own
 * timeout and never rejects, which would otherwise leave the overlay spinning
 * forever. Auto-retry attempts are excluded — those are already bounded by
 * `MAX_AGENT_SPAWN_ATTEMPTS`.
 */
export const CONNECT_TIMEOUT_SECONDS = 60;

/**
 * Client-side deadline for the `WaitingForAgent` park (#1129).
 *
 * A tab parked waiting for its agent transport to come online has no backend
 * timeout at all — if the agent never connects it would wait indefinitely.
 * After this bounded wait the tab settles as Failed with a hint so the user
 * can retry or cancel instead of staring at a permanent spinner.
 */
export const WAITING_FOR_AGENT_TIMEOUT_SECONDS = 30;

/** Formats whole seconds as a compact `mm:ss`-ish readout: `5s`, `1m 05s`. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

/**
 * Shown over a terminal slot while the backend session is being established.
 *
 * Five states (highest priority first):
 *   reattaching       — fetching cached scrollback after persistent session reattach
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
  const setTerminalConnecting = useAppStore((s) => s.setTerminalConnecting);
  const setTerminalWaitingForAgent = useAppStore((s) => s.setTerminalWaitingForAgent);
  const setTerminalSpawnError = useAppStore((s) => s.setTerminalSpawnError);
  const isConnecting = useAppStore((s) => s.terminalConnecting[tabId] ?? false);
  const autoRetryCount = useAppStore((s) => s.terminalAutoRetryCount[tabId] ?? 0);
  const waitingForAgent = useAppStore((s) => s.terminalWaitingForAgent[tabId]);
  const isReattaching = useAppStore((s) => s.terminalReattaching[tabId] ?? false);
  const error = useAppStore((s) => s.terminalSpawnErrors[tabId] ?? "");

  // Tick a wall-clock timer while any active connect attempt is in flight so the
  // overlay can show elapsed time and flag an unusually slow connect (#1127).
  const isActivelyConnecting = isConnecting || autoRetryCount > 0 || !!waitingForAgent;
  const elapsedSeconds = useElapsed(isActivelyConnecting);
  const elapsedLabel = formatElapsed(elapsedSeconds);
  const isSlowConnect = elapsedSeconds >= SLOW_CONNECT_THRESHOLD_SECONDS;

  // Bound the pending states with a client-side deadline (#1129). Without this,
  // `WaitingForAgent` parks forever if the agent never comes online, and a
  // `Connecting` attempt whose backend hangs past its own timeout never
  // settles. On the deadline the tab transitions to Failed with a hint that
  // explains the cause, reusing the existing spawn-error → Failed overlay path.
  //
  // The effect re-runs whenever the phase changes, so the timer is inherently
  // cleared on a successful connect, on cancel/unmount (React cleanup), and on
  // any transition to another phase — it can only fire against an attempt that
  // has stayed in the same pending phase for the full duration. Reattaching and
  // bounded auto-retries (already capped by MAX_AGENT_SPAWN_ATTEMPTS) are
  // excluded.
  useEffect(() => {
    if (isReattaching || autoRetryCount > 0) return;

    let timeoutMs: number;
    let hint: string;
    let clearActivePhase: () => void;
    if (waitingForAgent) {
      timeoutMs = WAITING_FOR_AGENT_TIMEOUT_SECONDS * 1000;
      hint = `Agent did not come online within ${WAITING_FOR_AGENT_TIMEOUT_SECONDS}s. The agent may be offline or unreachable — check the agent and retry.`;
      clearActivePhase = () => setTerminalWaitingForAgent(tabId, null);
    } else if (isConnecting) {
      timeoutMs = CONNECT_TIMEOUT_SECONDS * 1000;
      hint = `The connection did not complete within ${CONNECT_TIMEOUT_SECONDS}s. The host may be unreachable or unresponsive — check the connection and retry.`;
      clearActivePhase = () => setTerminalConnecting(tabId, false);
    } else {
      return;
    }

    const id = setTimeout(() => {
      frontendLog("terminal", `connect timeout fired for tab=${tabId} after ${timeoutMs}ms`);
      clearActivePhase();
      setTerminalSpawnError(tabId, hint);
    }, timeoutMs);

    return () => clearTimeout(id);
  }, [
    tabId,
    isConnecting,
    waitingForAgent,
    isReattaching,
    autoRetryCount,
    setTerminalConnecting,
    setTerminalWaitingForAgent,
    setTerminalSpawnError,
  ]);

  // Remaining seconds before the active pending phase times out — surfaced in
  // the overlay so the bounded wait is visible to the user (#1129, P7).
  const waitingRemaining = Math.max(0, WAITING_FOR_AGENT_TIMEOUT_SECONDS - elapsedSeconds);

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

  if (isReattaching) {
    return (
      <div className={cls} data-testid="terminal-connection-overlay">
        <div className="terminal-connection-overlay__body">
          <Loader2
            size={32}
            className="terminal-connection-overlay__icon terminal-connection-overlay__icon--spin"
          />
          <p className="terminal-connection-overlay__heading">Restoring session…</p>
          <p className="terminal-connection-overlay__subheading">
            Loading cached scrollback from the persistent session.
          </p>
        </div>
      </div>
    );
  }

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
          <p
            className="terminal-connection-overlay__elapsed"
            data-testid="terminal-connection-timeout-remaining"
          >
            Times out in {waitingRemaining}s
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
          <p
            className="terminal-connection-overlay__elapsed"
            data-testid="terminal-connection-elapsed"
          >
            Elapsed {elapsedLabel}
          </p>
          {isSlowConnect && (
            <p className="terminal-connection-overlay__hint-text">
              Taking longer than usual — the host may be slow to respond or unreachable.
            </p>
          )}
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
          <p
            className="terminal-connection-overlay__elapsed"
            data-testid="terminal-connection-elapsed"
          >
            Elapsed {elapsedLabel}
          </p>
          {isSlowConnect && (
            <p className="terminal-connection-overlay__hint-text">
              Taking longer than usual — the host may be slow to respond or unreachable.
            </p>
          )}
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
