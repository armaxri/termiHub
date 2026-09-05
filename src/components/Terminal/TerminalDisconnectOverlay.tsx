import { useCallback, useEffect, useState } from "react";
import {
  WifiOff,
  RefreshCw,
  X,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Unplug,
  Plus,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSessionLifecycle, useSessionAutoReconnect } from "@/store/useSessionLifecycle";
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
 * Auto-reconnect countdown variant (#1962): shown while the agentless resilient-
 * reconnect loop is waiting to make its next attempt. Renders a live countdown,
 * the attempt progress, an honest note that server-side state is not preserved
 * without an agent, and a Cancel affordance that stops the loop.
 */
function AutoReconnectingOverlay({ tabId }: { tabId: string }) {
  // The loop detail is sourced from the projected `session-lifecycle` region when
  // it faithfully mirrors appStore, else from appStore verbatim (#2204).
  const auto = useSessionAutoReconnect(tabId);
  const cancelAutoReconnect = useAppStore((s) => s.cancelAutoReconnect);
  // Tick once a second so the countdown stays live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const handleCancel = useCallback(() => {
    cancelAutoReconnect(tabId);
  }, [tabId, cancelAutoReconnect]);

  // Guard: the loop may have advanced out of "waiting" between the parent's
  // render and ours.
  if (!auto) return null;

  const secondsLeft = Math.max(0, Math.ceil((auto.nextAttemptAt - now) / 1000));
  const attemptLabel =
    auto.maxAttempts > 0
      ? `Attempt ${auto.attempt + 1} of ${auto.maxAttempts}`
      : `Attempt ${auto.attempt + 1}`;

  return (
    <div
      className="terminal-disconnect-overlay terminal-disconnect-overlay--reconnecting"
      data-testid="terminal-disconnect-overlay"
    >
      <div className="terminal-disconnect-overlay__body">
        <WifiOff size={32} className="terminal-disconnect-overlay__icon" />
        <p className="terminal-disconnect-overlay__heading">Connection lost — reconnecting…</p>
        <p
          className="terminal-disconnect-overlay__subheading"
          data-testid="terminal-auto-reconnect-countdown"
        >
          {secondsLeft > 0
            ? `Retrying in ${secondsLeft}s · ${attemptLabel}`
            : `Reconnecting… · ${attemptLabel}`}
        </p>
        <p className="terminal-disconnect-overlay__subheading terminal-disconnect-overlay__note">
          Local scrollback is preserved. Without an agent, the remote shell state (running commands,
          working directory) is not restored — a fresh shell opens.
        </p>
        {auto.onReconnectCommand && (
          <p
            className="terminal-disconnect-overlay__subheading terminal-disconnect-overlay__note"
            data-testid="terminal-auto-reconnect-command"
          >
            Will run <code>{auto.onReconnectCommand}</code> on reconnect.
          </p>
        )}
        <div className="terminal-disconnect-overlay__actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCancel}
            data-testid="terminal-auto-reconnect-cancel-btn"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown as an absolute overlay on top of the terminal content when the session
 * exits unexpectedly or while a reconnect is in progress.
 *
 * Variants (determined from store state, in priority order):
 *   - "session-lost"   — terminal: live agent session unrecoverable, "start new
 *                        shell" + view-scrollback buttons (#2512)
 *   - "auto-reconnect" — agentless resilient-reconnect countdown + Cancel (#1962)
 *   - "reconnecting"   — spinner, optional trigger error, Stop button
 *   - "error"          — error box, "Reconnect failed" heading, retry + view buttons
 *   - "disconnected"   — standard disconnect, reconnect + view-scrollback buttons
 *
 * The scrollback buffer is always preserved below the overlay.
 */
export function TerminalDisconnectOverlay({ tabId }: TerminalDisconnectOverlayProps) {
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  const dismissTerminalDisconnect = useAppStore((s) => s.dismissTerminalDisconnect);
  const cancelAutoReconnect = useAppStore((s) => s.cancelAutoReconnect);
  const startFreshShellForTab = useAppStore((s) => s.startFreshShellForTab);
  // Render cut (#2205 PR-A / #2442): the disconnect error, reconnect flag and the
  // reconnect-trigger error are all sourced from the projected `session-lifecycle`
  // region (falls back to appStore when it does not mirror). #2442 added the
  // region's distinct `reconnectError` field + `session.reconnectTrigger` intent
  // so the trigger error is region-owned rather than read from appStore directly.
  const lifecycle = useProjectedSessionLifecycle(tabId);
  const disconnectError = lifecycle.disconnectError;
  const isReconnecting = lifecycle.reconnecting;
  const reconnectTriggerError = lifecycle.reconnectTriggerError;
  // Terminal session-lost state (#2512): a resilient agent tab reconnected its
  // transport but its live agent session could not be recovered. Sourced from the
  // projected region (no appStore twin); the backend redrive emits it server-side.
  const isSessionLost = lifecycle.sessionLost;
  const sessionLostError = lifecycle.sessionLostError;
  // The auto-reconnect gate reads the same projected-with-fallback loop detail as
  // the countdown overlay itself, so the region drives which variant shows (#2204).
  const autoReconnectWaiting = useSessionAutoReconnect(tabId)?.phase === "waiting";
  // Exit-cause render cut (#2615 PR-A): the clean/dropped heading + subheading are
  // derived from the region's `exit` under the faithful-mirror gate (falling back
  // to the per-client `appStore.terminalExitInfo` slice), byte-identical to before.
  const exitInfo = lifecycle.exitInfo;

  const handleReconnect = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  const handleDismiss = useCallback(() => {
    dismissTerminalDisconnect(tabId);
  }, [tabId, dismissTerminalDisconnect]);

  // Stop the reconnecting loop (#2205 PR-B): fold the region out of reconnecting
  // via `session.cancelReconnect` (a clean user cancel → disconnected, `endReason:
  // user`), landing the tab on the standard disconnect overlay.
  const handleStop = useCallback(() => {
    cancelAutoReconnect(tabId);
  }, [tabId, cancelAutoReconnect]);

  const handleStartNewShell = useCallback(() => {
    startFreshShellForTab(tabId);
  }, [tabId, startFreshShellForTab]);

  // Session-lost (#2512) is terminal and takes precedence over every other
  // variant: the live agent session could not be recovered, so the tab offers an
  // explicit "start new shell" rather than a reconnect — never a silent new shell.
  if (isSessionLost) {
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

        <div className="terminal-disconnect-overlay__body" data-testid="terminal-session-lost">
          <Unplug
            size={32}
            className="terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--error"
          />

          <p className="terminal-disconnect-overlay__heading">Session lost</p>
          <p className="terminal-disconnect-overlay__subheading">
            The connection was restored, but the live session could not be recovered. Its process
            has ended. Scrollback is preserved below.
          </p>

          {sessionLostError && (
            <div
              className="terminal-disconnect-overlay__error-box"
              data-testid="terminal-session-lost-error-box"
            >
              <span className="terminal-disconnect-overlay__error-text">{sessionLostError}</span>
            </div>
          )}

          <div className="terminal-disconnect-overlay__actions">
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={14} />}
              onClick={handleStartNewShell}
              data-testid="terminal-session-lost-new-shell-btn"
            >
              Start New Shell
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

  // Agentless resilient reconnect (#1962) takes precedence: while the backoff
  // loop is counting down, show the countdown/Cancel variant instead of the
  // manual disconnect prompt.
  if (autoReconnectWaiting) {
    return <AutoReconnectingOverlay tabId={tabId} />;
  }

  if (isReconnecting) {
    return (
      <div
        className="terminal-disconnect-overlay terminal-disconnect-overlay--reconnecting"
        data-testid="terminal-disconnect-overlay"
      >
        <div className="terminal-disconnect-overlay__body">
          <Loader2
            size={32}
            className="terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--spin motion-essential-spinner"
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
