import { useCallback, useEffect, useRef } from "react";
import { RefreshCw, Zap, Ban, Copy, X } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui";
import {
  ConnectProgress,
  type ConnectProgressPhase,
  type ConnectStage,
} from "@/components/ui/ConnectProgress";
import { useTabConnectProgress } from "@/store/connectProgressBridge";
import { ABORTED_CONNECT_MESSAGE } from "@/store/reconnectHelpers";
import { buildStages, connectTypeLabel, stepsFor, type StepId } from "@/utils/connectStages";
import {
  connectTimeoutMessage,
  connectTimeoutMs,
  CONNECTING_TIMEOUT_MS,
} from "@/utils/connectTimeout";
import { ConnectTypeIcon } from "./ConnectTypeIcon";
import { useAppStore } from "@/store/appStore";
import { useProjectedSessionLifecycle } from "@/store/useSessionLifecycle";
import { useElapsed } from "@/hooks/useElapsed";
import { getPlatform } from "@/utils/platform";
import { backendFamilyFromSessionType, connectionErrorHint } from "@/utils/connectionErrorHints";
import { formatElapsed } from "@/utils/formatters";
import { CredentialReentry } from "./CredentialReentry";
import { markTerminalRefocusPending } from "./terminalRefocus";
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
   * Used, with the typed failure kind, to select contextual error hints.
   */
  sessionType?: string;
  /** The session runs on a remote agent (a `remote-session` tab). */
  viaAgent?: boolean;
  /** Host / port path from the tab's config; falls back to the tab title. */
  target?: string;
  /** Detail chips (port, jump host, baud rate). */
  details?: string[];
}

/** Seconds after which a still-pending connect is flagged as unusually slow. */
const SLOW_CONNECT_THRESHOLD_SECONDS = 20;

/**
 * A busy screen's announcement: heading plus one steady detail, joined like
 * {@link ContentOverlay}'s default (no second stop after "…"). Stage changes
 * deliberately do not re-announce.
 */
function busyAnnouncement(heading: string, detail: string): string {
  return `${heading}${/[.…!?:]$/.test(heading) ? " " : ". "}${detail}`;
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
 * Shown over a terminal slot while the backend session is being established —
 * the shared connect surface ({@link ConnectProgress}, #5068) for every shell
 * and connection type.
 *
 * States (highest priority first):
 *   reattaching       — fetching cached scrollback after persistent session reattach
 *   waiting-for-agent — parent agent transport still connecting (stage "Agent")
 *   auto-retrying     — agent session failed, retrying in background
 *   connecting        — createTerminal() is in-flight; backend stage reports
 *                       (`connect-progress`) drive the stepper
 *   failed            — spawn failed, timed out or was aborted; Retry or Close tab
 *
 * While busy the one action is Abort (the tab's own × closes it); Abort stops
 * the connect and keeps the tab on a retryable resting state (#1128).
 */
export function TerminalConnectionOverlay({
  tabId,
  panelId,
  tabTitle,
  isVisible,
  sessionType = "",
  viaAgent = false,
  target,
  details = [],
}: TerminalConnectionOverlayProps) {
  const closeTab = useAppStore((s) => s.closeTab);
  const retryTerminalSpawn = useAppStore((s) => s.retryTerminalSpawn);
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  const abortTerminalConnect = useAppStore((s) => s.abortTerminalConnect);
  // The connect flag is sourced from the authoritative `session-lifecycle` region
  // (#2205).
  const isConnecting = useProjectedSessionLifecycle(tabId).connecting;
  const autoRetryCount = useAppStore((s) => s.terminalAutoRetryCount[tabId] ?? 0);
  const waitingForAgent = useAppStore((s) => s.terminalWaitingForAgent[tabId]);
  const isReattaching = useAppStore((s) => s.terminalReattaching[tabId] ?? false);
  const error = useAppStore((s) => s.terminalSpawnErrors[tabId] ?? "");
  // Typed failure kind from the backend's locale-independent error code
  // (I18N-009) — the only input, with the backend family, to hint selection.
  const errorKind = useAppStore((s) => s.terminalSpawnErrorKinds[tabId] ?? "other");
  // The latest backend stage report for this tab's attempt (#5068).
  const progress = useTabConnectProgress(tabId);

  // Tick a wall-clock timer while any active connect attempt is in flight so the
  // overlay can flag an unusually slow connect (#1127).
  const isActivelyConnecting = isConnecting || autoRetryCount > 0 || !!waitingForAgent;
  const elapsedSeconds = useElapsed(isActivelyConnecting);
  const isSlowConnect = elapsedSeconds >= SLOW_CONNECT_THRESHOLD_SECONDS;

  // Client-side timeout: bound the WaitingForAgent and Connecting waits so a tab
  // can never park on an indefinite spinner (#1129). The deadline lives in the
  // store (set on entry to the timed state), so a remount re-arms the timer for
  // the REMAINING time rather than restarting the countdown (#1263).
  const failTerminalConnectTimeout = useAppStore((s) => s.failTerminalConnectTimeout);
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

  // The ring's start: derived from the stored deadline so it survives a
  // remount; without one (auto-retry, reattach) from when this overlay mounted.
  const mountedAt = useRef(Date.now()).current;
  const startedAt =
    deadlineAt !== undefined && deadlineKind
      ? deadlineAt - connectTimeoutMs(deadlineKind)
      : mountedAt;

  const handleCancel = useCallback(() => {
    closeTab(tabId, panelId);
  }, [tabId, panelId, closeTab]);

  const handleRetry = useCallback(() => {
    // Return focus to the terminal once the retry connects (#4513).
    markTerminalRefocusPending(tabId);
    retryTerminalSpawn(tabId);
  }, [tabId, retryTerminalSpawn]);

  // Abort: stop the in-flight connect and land on a retryable resting state,
  // keeping the tab open (#1128).
  const handleAbort = useCallback(() => {
    abortTerminalConnect(tabId);
  }, [tabId, abortTerminalConnect]);

  // Retry now (waiting-for-agent): stop parking on the agent and re-run the
  // spawn immediately. retryTerminalSpawn already clears the waiting flag.
  const handleRetryNowWaiting = useCallback(() => {
    retryTerminalSpawn(tabId);
  }, [tabId, retryTerminalSpawn]);

  // Retry now (auto-retrying): cancel the pending retry-delay loop and kick a
  // fresh attempt at once, mirroring the agent-reconnect restart path.
  const handleRetryNowAutoRetry = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  // Remediation commands are host-OS specific (#1831). The hint is a pure
  // function of (backend family, failure kind) (#2088, I18N-009).
  const platform = getPlatform();
  const backendFamily = backendFamilyFromSessionType(sessionType);
  const hint = connectionErrorHint(backendFamily, errorKind, platform);
  const hintCopyTestId =
    errorKind === "agent-auth"
      ? "terminal-connection-agent-copy-btn"
      : "terminal-connection-serial-copy-btn";

  const cls = `terminal-connection-overlay${isVisible ? "" : " terminal-connection-overlay--hidden"}`;
  const steps = stepsFor(sessionType, viaAgent);
  const reported: StepId | undefined =
    progress && steps.includes(progress.stage) ? progress.stage : undefined;
  const slowHint = isSlowConnect ? (
    <p className="terminal-connection-overlay__hint-text">
      Taking longer than usual — the host may be slow to respond or unreachable.
    </p>
  ) : null;
  const common = {
    target: target || tabTitle,
    typeLabel: connectTypeLabel(sessionType),
    typeIcon: <ConnectTypeIcon type={sessionType} />,
    details: viaAgent ? [...details, "via agent"] : details,
    startedAt,
    deadlineAt,
  };
  const abortBtn = (
    <Button
      size="sm"
      variant="secondary"
      icon={<Ban size={14} />}
      onClick={handleAbort}
      data-testid="terminal-connection-abort-btn"
    >
      Abort
    </Button>
  );
  const retryNowBtn = (onClick: () => void) => (
    <Button
      size="sm"
      variant="secondary"
      icon={<Zap size={14} />}
      onClick={onClick}
      data-testid="terminal-connection-retry-now-btn"
    >
      Retry now
    </Button>
  );

  if (isReattaching) {
    return (
      <div className={cls} data-testid="terminal-connection-overlay">
        <ConnectProgress
          {...common}
          phase="connecting"
          heading="Restoring session…"
          status="Loading cached scrollback from the persistent session."
          announcement={busyAnnouncement(
            "Restoring session…",
            "Loading cached scrollback from the persistent session."
          )}
          deadlineAt={undefined}
          timeText=""
        />
      </div>
    );
  }

  if (waitingForAgent) {
    return (
      <div className={cls} data-testid="terminal-connection-overlay">
        <ConnectProgress
          {...common}
          phase="connecting"
          stages={buildStages(["agent", "start"], "agent")}
          status="Waiting for the agent to connect before starting the session."
          announcement={busyAnnouncement(
            `Connecting to ${common.target}`,
            "Waiting for the agent to connect before starting the session."
          )}
          timeTestId="terminal-connection-timeout"
          actions={
            <>
              {retryNowBtn(handleRetryNowWaiting)}
              {abortBtn}
            </>
          }
        />
      </div>
    );
  }

  if (autoRetryCount > 0) {
    return (
      <div className={cls} data-testid="terminal-connection-overlay">
        <ConnectProgress
          {...common}
          phase="retrying"
          attempt={{ current: autoRetryCount + 1 }}
          announcement={busyAnnouncement(
            `Reconnecting to ${common.target}`,
            `Attempt ${autoRetryCount + 1}`
          )}
          deadlineAt={undefined}
          timeTestId="terminal-connection-elapsed"
          actions={
            <>
              {retryNowBtn(handleRetryNowAutoRetry)}
              {abortBtn}
            </>
          }
        >
          {slowHint}
        </ConnectProgress>
      </div>
    );
  }

  if (isConnecting) {
    const stages: ConnectStage[] = buildStages(steps, viaAgent ? "start" : reported);
    return (
      <div className={cls} data-testid="terminal-connection-overlay">
        <ConnectProgress
          {...common}
          phase="connecting"
          announcement={`Connecting to ${common.target}…`}
          stages={stages}
          status={progress?.status ?? undefined}
          timeTestId="terminal-connection-elapsed"
          actions={abortBtn}
        >
          {slowHint}
        </ConnectProgress>
      </div>
    );
  }

  // Resting: failed, timed out, or aborted by the user.
  const phase: ConnectProgressPhase =
    error === ABORTED_CONNECT_MESSAGE ? "aborted" : errorKind === "timeout" ? "timeout" : "failed";
  // Mark the stage it stopped at — only when it is actually known (a reported
  // stage, an agent session, or a single-step type).
  const failedAt: StepId | undefined = viaAgent ? "start" : reported;
  const showSteps = failedAt !== undefined || steps.length === 1;
  const headings: Record<ConnectProgressPhase, string> = {
    failed: "Connection failed",
    timeout: "Connection timed out",
    aborted: "Connection aborted",
    connecting: "",
    retrying: "",
  };
  return (
    <div className={cls} data-testid="terminal-connection-overlay">
      <ConnectProgress
        {...common}
        phase={phase}
        heading={headings[phase]}
        stages={showSteps ? buildStages(steps, failedAt, true) : undefined}
        // `error` is already the store's display string, not a raw IPC error.
        error={error}
        announcement={[`${headings[phase]}.`, `${tabTitle}:`, error].join(" ")}
        autoFocusPrimaryAction={isVisible}
        // Only the client's own deadline knows how long it waited.
        timeText={
          error === connectTimeoutMessage("connecting")
            ? `Gave up after ${formatElapsed(Math.round(CONNECTING_TIMEOUT_MS / 1000))}`
            : ""
        }
        actions={
          <>
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
              icon={<X size={14} />}
              onClick={handleCancel}
              data-testid="terminal-connection-cancel-btn"
            >
              Close tab
            </Button>
          </>
        }
      >
        {hint &&
          (hint.title || hint.command ? (
            <div className="terminal-connection-overlay__hint">
              {hint.title && (
                <p className="terminal-connection-overlay__hint-title">{hint.title}</p>
              )}
              <p>{hint.text}</p>
              {hint.command && <CommandBlock command={hint.command} testId={hintCopyTestId} />}
            </div>
          ) : (
            <p className="terminal-connection-overlay__hint-text">{hint.text}</p>
          ))}
        {/* The server rejected the credentials (typed `auth_failed` kind):
            offer to enter new ones inline and reconnect (#3089). */}
        {errorKind === "auth" && <CredentialReentry tabId={tabId} />}
      </ConnectProgress>
    </div>
  );
}
