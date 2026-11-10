import { useCallback, useId } from "react";
import { WifiOff, RefreshCw, X, AlertTriangle, CheckCircle2, Unplug, Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSessionLifecycle, useSessionAutoReconnect } from "@/store/useSessionLifecycle";
import { Button, ContentOverlay, Tooltip } from "@/components/ui";
import type { TerminalExitInfo } from "@/types/terminal";
import { CredentialReentry } from "./CredentialReentry";
import { markTerminalRefocusPending } from "./terminalRefocus";
import { TerminalPluginExitOverlay } from "./TerminalPluginExitOverlay";
import { TerminalReconnectStrip } from "./TerminalReconnectStrip";
import "./TerminalDisconnectOverlay.css";

interface TerminalDisconnectOverlayProps {
  tabId: string;
  /**
   * Whether this tab is the visible one in its panel. Only the active tab's
   * overlay moves focus to its primary action (#4331); background tabs never
   * steal it.
   */
  isActive?: boolean;
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
 * exits unexpectedly or while a reconnect is in progress.
 *
 * Variants (determined from store state, in priority order):
 *   - "session-lost"   — terminal: live agent session unrecoverable, "start new
 *                        shell" + view-scrollback buttons (#2512)
 *   - "plugin-exit"    — the sandboxed plugin process crashed / hung / ran out of
 *                        memory / sent invalid data: restart session + close tab
 *                        (#4188, {@link TerminalPluginExitOverlay})
 *   - "reconnecting"   — non-blocking top strip, not an overlay (#5179): the
 *                        agentless countdown + attempt n/N + Cancel (#1962), or
 *                        a spinner + Stop ({@link TerminalReconnectStrip})
 *   - "error"          — error box, "Reconnect failed" heading, retry + view buttons
 *   - "disconnected"   — standard disconnect, reconnect + view-scrollback buttons
 *
 * The scrollback buffer is always preserved below the overlay; while
 * reconnecting it stays readable and selectable under the strip.
 */
export function TerminalDisconnectOverlay({
  tabId,
  isActive = false,
}: TerminalDisconnectOverlayProps) {
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  const dismissTerminalDisconnect = useAppStore((s) => s.dismissTerminalDisconnect);
  const startFreshShellForTab = useAppStore((s) => s.startFreshShellForTab);
  // The disconnect error, reconnect flag and the reconnect-trigger error are all
  // sourced from the authoritative `session-lifecycle` region (#2205). #2442 added the
  // region's distinct `reconnectError` field + `session.reconnectTrigger` intent
  // so the trigger error is region-owned rather than read from appStore directly.
  const lifecycle = useProjectedSessionLifecycle(tabId);
  const disconnectError = lifecycle.disconnectError;
  // Terminal, non-retryable auth rejection (SM-005): same error overlay treatment
  // as a plain failure, but with auth-specific heading/subheading wording.
  const isAuthFailed = lifecycle.authFailed;
  const isReconnecting = lifecycle.reconnecting;
  const reconnectTriggerError = lifecycle.reconnectTriggerError;
  // Terminal session-lost state (#2512): a resilient agent tab reconnected its
  // transport but its live agent session could not be recovered. Sourced from the
  // projected region (no appStore twin); the backend redrive emits it server-side.
  const isSessionLost = lifecycle.sessionLost;
  const sessionLostError = lifecycle.sessionLostError;
  // The auto-reconnect gate reads the same projected-with-fallback loop detail as
  // the countdown overlay itself, so the region drives which variant shows (#2204).
  const autoReconnectActive = useSessionAutoReconnect(tabId) !== undefined;
  // Exit-cause render cut (#2615 / #2625): the clean/dropped heading + subheading
  // are derived purely from the region's `exit` metadata (the per-client
  // `appStore.terminalExitInfo` slice was deleted).
  const exitInfo = lifecycle.exitInfo;
  // The error text is part of each failure overlay's accessible description.
  const errorTextId = useId();

  // A user-started reconnect returns focus to the terminal once the session is
  // back, unless the user has moved focus elsewhere meanwhile (#4513).
  const handleReconnect = useCallback(() => {
    markTerminalRefocusPending(tabId);
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  const handleDismiss = useCallback(() => {
    dismissTerminalDisconnect(tabId);
  }, [tabId, dismissTerminalDisconnect]);

  const handleStartNewShell = useCallback(() => {
    markTerminalRefocusPending(tabId);
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

        <ContentOverlay
          className="terminal-disconnect-overlay__body"
          data-testid="terminal-session-lost"
          icon={
            <Unplug
              size={32}
              className="terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--error"
            />
          }
          heading="Session lost"
          subheading="The connection was restored, but the live session could not be recovered. Its process has ended. Scrollback is preserved below."
          announce="assertive"
          // Without a backend cause, the heading + subheading are announced.
          announcement={sessionLostError ? `Session lost. ${sessionLostError}` : undefined}
          describedBy={sessionLostError ? errorTextId : undefined}
          autoFocusPrimaryAction={isActive}
          actions={
            <>
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
            </>
          }
        >
          {sessionLostError && (
            <div
              className="terminal-disconnect-overlay__error-box"
              data-testid="terminal-session-lost-error-box"
            >
              <span id={errorTextId} className="terminal-disconnect-overlay__error-text">
                {sessionLostError}
              </span>
            </div>
          )}
        </ContentOverlay>
      </div>
    );
  }

  // A plugin tab whose sandboxed plugin process failed (#4188): the plugin
  // crash overlay with the cause and a manual Restart session (plugin types
  // have no auto-reconnect, PLG-004).
  if (lifecycle.pluginExit) {
    return (
      <TerminalPluginExitOverlay tabId={tabId} exit={lifecycle.pluginExit} isActive={isActive} />
    );
  }

  // A running reconnect — the agentless backoff loop (#1962, waiting or
  // connecting) or a plain in-flight reconnect — is not a terminal state, so it
  // renders as a non-blocking strip at the top of the terminal (#5179): the
  // scrollback stays readable and selectable while the attempts run. Only the
  // terminal states below keep the full overlay.
  if (autoReconnectActive || isReconnecting) {
    return <TerminalReconnectStrip tabId={tabId} reconnectTriggerError={reconnectTriggerError} />;
  }

  if (disconnectError) {
    const errorHeading = isAuthFailed ? "Authentication failed" : "Reconnect failed";
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

        <ContentOverlay
          className="terminal-disconnect-overlay__body"
          icon={
            <AlertTriangle
              size={32}
              className="terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--error"
            />
          }
          heading={errorHeading}
          announce="assertive"
          announcement={`${errorHeading}. ${disconnectError}`}
          describedBy={errorTextId}
          autoFocusPrimaryAction={isActive}
          subheading={
            isAuthFailed
              ? "Check your credentials, then reconnect. Scrollback is preserved below."
              : "All reconnect attempts were exhausted. Scrollback is preserved below."
          }
          actions={
            <>
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
            </>
          }
        >
          <div
            className="terminal-disconnect-overlay__error-box"
            data-testid="terminal-disconnect-error-box"
          >
            <span id={errorTextId} className="terminal-disconnect-overlay__error-text">
              {disconnectError}
            </span>
          </div>
          {/* A rejected credential (SM-005): offer to enter a new one inline
              rather than only re-sending the rejected one (#3089). */}
          {isAuthFailed && <CredentialReentry tabId={tabId} />}
        </ContentOverlay>
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

      <ContentOverlay
        className="terminal-disconnect-overlay__body"
        icon={
          copy.clean ? (
            <CheckCircle2 size={32} className="terminal-disconnect-overlay__icon" />
          ) : (
            <WifiOff size={32} className="terminal-disconnect-overlay__icon" />
          )
        }
        heading={copy.heading}
        subheading={copy.subheading}
        announce="polite"
        autoFocusPrimaryAction={isActive}
        actions={
          <>
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
          </>
        }
      />
    </div>
  );
}
