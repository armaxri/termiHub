import { useCallback, useEffect } from "react";
import { ServerCrash, RefreshCw, Loader2, Zap, Ban, Copy } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useElapsed } from "@/hooks/useElapsed";
import { getPlatform } from "@/utils/platform";
import { backendFamilyFromSessionType, connectionErrorHint } from "@/utils/connectionErrorHints";
import { sshAgentStartCommand } from "@/utils/sshAgentSetup";
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
 * Platform-appropriate guidance for a serial permission error on non-Linux hosts
 * (#1831). Only Linux gates serial ports behind the `dialout` group, so its hint
 * offers the `usermod` fix command (rendered separately as a copyable block). On
 * Windows a denied `COM` port and on macOS a denied `/dev/tty.*` port almost
 * always mean another program holds the port or the user lacks access — there is
 * no group to join, so we show plain guidance rather than a bogus command.
 */
const SERIAL_PERMISSION_HINT: Record<"windows" | "macos", string> = {
  windows:
    "Another application may be using the port, or you may not have permission to access it. Close any program using the port and try again.",
  macos:
    "You may not have permission to access this port, or another application may be using it. Close any program using the port and try again.",
};

/** Seconds after which a still-pending connect is flagged as unusually slow. */
const SLOW_CONNECT_THRESHOLD_SECONDS = 20;

/** Formats whole seconds as a compact `mm:ss`-ish readout: `5s`, `1m 05s`. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

/**
 * Copy a suggested fix command to the clipboard so the user can paste and run it
 * instead of retyping it by hand (#1829). Returns the promise so the Button drives
 * its success flash; a rejection surfaces via the Button's error toast.
 */
async function copyCommand(command: string): Promise<void> {
  await writeClipboard(command);
  toast.success("Command copied to clipboard");
}

/**
 * A suggested shell command shown on the failure screen, with a copy affordance
 * (#1829): the command text is selectable, and a ghost icon button copies it to
 * the clipboard with a success toast. Reuses the pattern established for the
 * X-server setup dialog (#1819).
 */
function CommandBlock({ command, testId }: { command: string; testId?: string }) {
  return (
    <div className="terminal-connection-overlay__command-row">
      <code className="terminal-connection-overlay__hint-code">{command}</code>
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        icon={<Copy size={14} aria-hidden />}
        aria-label="Copy command"
        title="Copy command"
        data-testid={testId}
        onClick={() => copyCommand(command)}
      />
    </div>
  );
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
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  const abortTerminalConnect = useAppStore((s) => s.abortTerminalConnect);
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

  // Client-side timeout: bound the WaitingForAgent and Connecting waits so a tab
  // can never park on an indefinite spinner. WaitingForAgent has no backend
  // timeout at all; Connecting relies on the backend one, so this is a safety
  // net that outlasts it. On expiry the tab transitions to Failed with a
  // contextual hint (#1129). auto-retry manages its own visible-failure cadence,
  // so it is intentionally not timed here.
  const failTerminalConnectTimeout = useAppStore((s) => s.failTerminalConnectTimeout);
  // The timeout is anchored to a wall-clock deadline held in the store (set on
  // entry to the timed state), not to this component's lifetime. The overlay
  // only reads it, so unmounting and remounting mid-connect (dragging the tab to
  // another panel/split, a zoom re-key) re-arms the timer for the REMAINING time
  // rather than restarting the countdown from zero (#1263).
  const connectDeadline = useAppStore((s) => s.terminalConnectDeadline[tabId]);
  const deadlineAt = connectDeadline?.at;
  const deadlineKind = connectDeadline?.kind;

  useEffect(() => {
    if (deadlineAt === undefined || !deadlineKind) return;
    const id = setTimeout(
      () => failTerminalConnectTimeout(tabId, deadlineKind),
      Math.max(0, deadlineAt - Date.now())
    );
    return () => clearTimeout(id);
  }, [tabId, deadlineAt, deadlineKind, failTerminalConnectTimeout]);

  // Whole seconds remaining before the timeout fires (>= 0), for the visible
  // countdown. Derived from the same stored deadline as the timer above and
  // recomputed on the per-second elapsed tick (elapsedSeconds), so the display
  // and the actual fire share one clock and both survive a remount.
  const remainingSeconds =
    deadlineAt !== undefined ? Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)) : 0;

  const handleCancel = useCallback(() => {
    closeTab(tabId, panelId);
  }, [tabId, panelId, closeTab]);

  const handleRetry = useCallback(() => {
    retryTerminalSpawn(tabId);
  }, [tabId, retryTerminalSpawn]);

  // Abort: stop the in-flight connect and land on a retryable Failed state,
  // keeping the tab open — distinct from Cancel, which closes the tab (#1128).
  const handleAbort = useCallback(() => {
    abortTerminalConnect(tabId);
  }, [tabId, abortTerminalConnect]);

  // Retry now (waiting-for-agent): stop parking on the agent and re-run the
  // spawn immediately, mirroring the wake path when the agent comes online.
  // retryTerminalSpawn already clears the waiting flag as part of the retry.
  const handleRetryNowWaiting = useCallback(() => {
    retryTerminalSpawn(tabId);
  }, [tabId, retryTerminalSpawn]);

  // Retry now (auto-retrying): cancel the pending retry-delay loop and kick a
  // fresh attempt at once, mirroring the agent-reconnect restart path.
  const handleRetryNowAutoRetry = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  const isSerial = sessionType === "serial";
  // The serial permission remediation is host-OS specific: only Linux has the
  // dialout group, so the `usermod` fix must not be shown on Windows/macOS (#1831).
  const platform = getPlatform();
  // Resolve the backend family so every failure hint is chosen for the backend
  // that actually raised it, not shown blanket across all backends (#2088).
  const backendFamily = backendFamilyFromSessionType(sessionType);
  // "Agent auth failed" is an SSH ssh-agent (key-auth) failure, so its remedy
  // (starting ssh-agent) only makes sense on the SSH path — gate it to the SSH
  // family so the SSH-agent hint can't leak onto telnet/serial/etc. (#2088).
  const isAgentAuth = backendFamily === "ssh" && error.includes(SSH_AGENT_PATTERN);
  const isTimeout = error.includes(TIMEOUT_PATTERN) && !isAgentAuth;
  // Backend-appropriate timeout guidance, sourced from the structured per-backend
  // table rather than an inline string, so it can never again describe the wrong
  // backend (e.g. the old "agent binary is installed" hint on an SSH timeout).
  const timeoutHint = isTimeout ? connectionErrorHint(backendFamily, "timeout") : null;
  const isSerialNotFound = isSerial && SERIAL_NOT_FOUND_PATTERNS.some((p) => error.includes(p));
  const isSerialPermission = isSerial && error.includes(SERIAL_PERMISSION_PATTERN);
  const isSerialBusy =
    isSerial && !isSerialPermission && SERIAL_BUSY_PATTERNS.some((p) => error.includes(p));

  // When a curated hint panel is shown it fully explains the failure and, since
  // #1829, offers the fix command with a copy affordance. Backend errors append
  // that same remediation to the raw message after an em-dash separator (see
  // core/src/session/serial.rs), so rendering the raw error verbatim repeated
  // the guidance and command — once as plain text, once in the hint (#1830).
  // Drop the trailing remediation clause from the raw error box so the hint
  // panel is the single source of the remediation.
  const hasHint =
    isAgentAuth || isTimeout || isSerialNotFound || isSerialPermission || isSerialBusy;
  const displayError = hasHint ? error.split(" — ")[0].trim() : error;

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
            data-testid="terminal-connection-timeout"
          >
            Times out in {remainingSeconds}s
          </p>
          <div className="terminal-connection-overlay__actions">
            <Button
              size="sm"
              variant="primary"
              icon={<Zap size={14} />}
              onClick={handleRetryNowWaiting}
              data-testid="terminal-connection-retry-now-btn"
            >
              Retry now
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Ban size={14} />}
              onClick={handleAbort}
              data-testid="terminal-connection-abort-btn"
            >
              Abort
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCancel}
              data-testid="terminal-connection-cancel-btn"
            >
              Cancel
            </Button>
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
            <Button
              size="sm"
              variant="primary"
              icon={<Zap size={14} />}
              onClick={handleRetryNowAutoRetry}
              data-testid="terminal-connection-retry-now-btn"
            >
              Retry now
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Ban size={14} />}
              onClick={handleAbort}
              data-testid="terminal-connection-abort-btn"
            >
              Abort
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCancel}
              data-testid="terminal-connection-cancel-btn"
            >
              Cancel
            </Button>
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
            Elapsed {elapsedLabel} · times out in {remainingSeconds}s
          </p>
          {isSlowConnect && (
            <p className="terminal-connection-overlay__hint-text">
              Taking longer than usual — the host may be slow to respond or unreachable.
            </p>
          )}
          <div className="terminal-connection-overlay__actions">
            <Button
              size="sm"
              variant="secondary"
              icon={<Ban size={14} />}
              onClick={handleAbort}
              data-testid="terminal-connection-abort-btn"
            >
              Abort
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCancel}
              data-testid="terminal-connection-cancel-btn"
            >
              Cancel
            </Button>
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
          <span className="terminal-connection-overlay__error-text">{displayError}</span>
        </div>

        {isAgentAuth && (
          <div className="terminal-connection-overlay__hint">
            <p className="terminal-connection-overlay__hint-title">SSH Agent not running</p>
            <p>
              Open the connection editor and use the <strong>Setup SSH Agent</strong> button, or
              run:
            </p>
            <CommandBlock
              command={sshAgentStartCommand(platform)}
              testId="terminal-connection-agent-copy-btn"
            />
          </div>
        )}

        {isTimeout && timeoutHint && (
          <p className="terminal-connection-overlay__hint-text">{timeoutHint}</p>
        )}

        {isSerialNotFound && (
          <p className="terminal-connection-overlay__hint-text">
            Serial port not found. Check that the device is connected and the port name is correct.
          </p>
        )}

        {isSerialPermission && (
          <div className="terminal-connection-overlay__hint">
            <p className="terminal-connection-overlay__hint-title">Permission denied</p>
            {platform === "linux" ? (
              <>
                <p>On Linux, add your user to the dialout group and re-login:</p>
                <CommandBlock
                  command="sudo usermod -aG dialout $USER"
                  testId="terminal-connection-serial-copy-btn"
                />
              </>
            ) : (
              <p>{SERIAL_PERMISSION_HINT[platform]}</p>
            )}
          </div>
        )}

        {isSerialBusy && (
          <p className="terminal-connection-overlay__hint-text">
            The serial port is already in use by another application.
          </p>
        )}

        <div className="terminal-connection-overlay__actions">
          <Button
            size="sm"
            variant="primary"
            icon={<RefreshCw size={14} />}
            onClick={handleRetry}
            data-testid="terminal-connection-retry-btn"
          >
            Retry
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCancel}
            data-testid="terminal-connection-cancel-btn"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
