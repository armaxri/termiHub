import { useCallback, useId } from "react";
import { RefreshCw, AlertTriangle, Unplug, Plus, RotateCcw } from "lucide-react";
import { connectionIdentityForTabId, isAutoReconnectOffTabId, useAppStore } from "@/store/appStore";
import { useProjectedSessionLifecycle, useSessionAutoReconnect } from "@/store/useSessionLifecycle";
import { Button, ContentOverlay } from "@/components/ui";
import type { TerminalExitInfo } from "@/types/terminal";
import type { SessionEndCause } from "@/types/generated/SessionEndCause";
import { t } from "@/i18n/catalog";
import { CredentialReentry } from "./CredentialReentry";
import { DisconnectStrip, type DisconnectStripTone } from "./DisconnectStrip";
import {
  disconnectCauseLine,
  disconnectCauseOf,
  dropTransportOf,
  isLinkDrop,
  sessionEndActionLabel,
  sessionEndEnterHint,
  sessionEndNoticeFor,
  type DisconnectCause,
  type DropTransport,
  type SessionEndKind,
  type SessionEndNotice,
} from "./dropCopy";
import { markTerminalRefocusPending } from "./terminalRefocus";
import { TerminalPluginExitOverlay } from "./TerminalPluginExitOverlay";
import { TerminalReconnectStrip } from "./TerminalReconnectStrip";
import { SESSION_END_ICONS } from "./sessionEndIcons";
import "./TerminalDisconnectOverlay.css";
import { connectionStateHeading, connectionVerb } from "@/utils/connectionStateCopy";

interface TerminalDisconnectOverlayProps {
  tabId: string;
  /**
   * Whether this tab is the visible one in its panel. Only the active tab's
   * overlay moves focus to its primary action (#4331); background tabs never
   * steal it.
   */
  isActive?: boolean;
}

/**
 * The scrollback stays readable around the notice (#5831, R-028): the overlay
 * has no scrim, so it only has to say the scrollback is kept.
 */
const SCROLLBACK_KEPT = t("drop.overlay.scrollbackKept");

/** The strip tint per kind of end: a process end is calm, a drop a warning. */
const END_TONES: Record<SessionEndKind, DisconnectStripTone> = {
  exited: "neutral",
  ended: "neutral",
  user: "neutral",
  device: "warning",
  link: "warning",
};

/** A tab's disconnect cause and what its cause line needs (#5831). */
interface TabDisconnectCause {
  transport: DropTransport;
  cause: DisconnectCause | undefined;
  /** The serial port path, for a serial tab. */
  device: string | undefined;
}

/**
 * Classify why `tabId`'s session ended (#5831), from its connection's transport,
 * the region's exit and the link's end cause. Shared by the overlay and the
 * view-mode banner so both say the same.
 */
function disconnectCauseForTab(
  tabId: string,
  exit: TerminalExitInfo | undefined,
  endCause: SessionEndCause | undefined
): TabDisconnectCause {
  const identity = connectionIdentityForTabId(tabId);
  const transport = dropTransportOf(identity);
  return {
    transport,
    cause: disconnectCauseOf({ transport, exit, endCause }),
    device: transport === "serial" ? identity?.target : undefined,
  };
}

/**
 * The cause line for a tab whose session ended (#5831), or `undefined` when
 * nothing is known about why.
 */
export function disconnectCauseLineForTab(
  tabId: string,
  exit: TerminalExitInfo | undefined,
  endCause: SessionEndCause | undefined
): string | undefined {
  const { cause, device } = disconnectCauseForTab(tabId, exit, endCause);
  return cause ? disconnectCauseLine(cause, { code: exit?.code, device }) : undefined;
}

/**
 * The session-end notice for a tab (#5910): its heading, cause line and
 * whether its action restarts a process or reconnects a link. Shared by the
 * strip and the view-mode banner so both say the same.
 */
export function sessionEndNoticeForTab(
  tabId: string,
  exit: TerminalExitInfo | undefined,
  endCause: SessionEndCause | undefined
): SessionEndNotice {
  const { transport, cause, device } = disconnectCauseForTab(tabId, exit, endCause);
  return sessionEndNoticeFor(cause, { transport, code: exit?.code, device });
}

/**
 * Shown as a full-width strip at the top of the terminal slot when the session
 * ends or while a reconnect is in progress.
 *
 * Variants (determined from store state, in priority order):
 *   - "session-lost"   — terminal: live agent session unrecoverable, "start new
 *                        shell" (#2512)
 *   - "plugin-exit"    — the sandboxed plugin process crashed / hung / ran out of
 *                        memory / sent invalid data: restart session + close tab
 *                        (#4188, {@link TerminalPluginExitOverlay})
 *   - "reconnecting"   — non-blocking top strip, not an overlay (#5179): the
 *                        agentless countdown + attempt n/N + Cancel (#1962), or
 *                        a spinner + Stop ({@link TerminalReconnectStrip})
 *   - "error"          — error box, "Connection failed" heading, Retry button
 *   - "disconnected"   — the session ended: "Process exited (code N)" + Restart
 *                        for a process, "Session disconnected" + Reconnect for
 *                        a dropped link (#5910), with a "Press Enter to …" hint
 *
 * One dismiss control for every variant: the strip's "x" (#5955). A "View
 * scrollback" button beside it did the same and read as if the scrollback
 * were hidden, so it is gone.
 *
 * The scrollback buffer is always preserved and fully visible: every variant is
 * a strip that pushes the terminal down below it (#5908, {@link DisconnectStrip}),
 * so no output line is covered and all of it stays selectable.
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
  // Why the session ended (#5831): one cause line in every variant. The link's
  // end cause outlives the exit (a reconnect loop clears the exit), so the
  // give-up overlay can still say why the session dropped.
  const { transport, cause, device } = disconnectCauseForTab(tabId, exitInfo, lifecycle.endCause);
  // A dropped link on a connection with auto-reconnect off says so and where to
  // turn it on (#5831, R-061/R-062), so the manual overlay is never a surprise.
  const autoReconnectOff = isLinkDrop(cause) && isAutoReconnectOffTabId(tabId);
  const autoReconnectOffNote =
    transport === "telnet" ? t("drop.autoReconnectOffTelnet") : t("drop.autoReconnectOff");
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
      <DisconnectStrip variant="session-lost" tone="error" onDismiss={handleDismiss}>
        <ContentOverlay
          className="terminal-disconnect-overlay__body"
          data-testid="terminal-session-lost"
          icon={
            <Unplug
              size={16}
              className="terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--error"
            />
          }
          heading="Session lost"
          subheading={`The connection was restored, but the live session could not be recovered. Its process has ended. ${SCROLLBACK_KEPT}`}
          announce="assertive"
          // Without a backend cause, the heading + subheading are announced.
          announcement={sessionLostError ? `Session lost. ${sessionLostError}` : undefined}
          describedBy={sessionLostError ? errorTextId : undefined}
          autoFocusPrimaryAction={isActive}
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={14} />}
              onClick={handleStartNewShell}
              data-testid="terminal-session-lost-new-shell-btn"
            >
              Start new shell
            </Button>
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
      </DisconnectStrip>
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
    // Every reconnect attempt failed (#6159): the connection failed, and
    // Retry tries it again.
    const errorHeading = isAuthFailed ? "Authentication failed" : connectionStateHeading("failed");
    return (
      <DisconnectStrip variant="failed" cause={cause} tone="error" onDismiss={handleDismiss}>
        <ContentOverlay
          className="terminal-disconnect-overlay__body"
          icon={
            <AlertTriangle
              size={16}
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
              ? `Check your credentials, then reconnect. ${SCROLLBACK_KEPT}`
              : [
                  isLinkDrop(cause) && cause ? disconnectCauseLine(cause, { device }) : null,
                  "All reconnect attempts were exhausted.",
                  SCROLLBACK_KEPT,
                ]
                  .filter(Boolean)
                  .join(" ")
          }
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={handleReconnect}
              data-testid="terminal-disconnect-reconnect-btn"
            >
              {connectionVerb("retry")}
            </Button>
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
      </DisconnectStrip>
    );
  }

  // A process that exits is not a lost connection (#5910): the heading, icon
  // and action follow the kind of end.
  const notice = sessionEndNoticeFor(cause, { transport, code: exitInfo?.code, device });
  const EndIcon = SESSION_END_ICONS[notice.kind];
  const actionLabel = sessionEndActionLabel(notice.action);
  // Every kind of end says the same "Press Enter to …" as the view-mode
  // banner (#5955): Enter runs the strip's action, from its button or the
  // terminal.
  const subheading = [notice.causeLine, SCROLLBACK_KEPT, sessionEndEnterHint(notice.action)]
    .filter(Boolean)
    .join(" ");

  return (
    <DisconnectStrip
      variant="disconnected"
      cause={cause ?? "lost"}
      tone={END_TONES[notice.kind]}
      onDismiss={handleDismiss}
      dismissLabel="Dismiss disconnect notice and view scrollback"
    >
      <ContentOverlay
        className="terminal-disconnect-overlay__body"
        icon={
          <EndIcon
            size={16}
            className={`terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--${notice.kind}`}
            data-testid={`terminal-disconnect-icon-${notice.kind}`}
          />
        }
        heading={notice.heading}
        subheading={subheading}
        announce="polite"
        autoFocusPrimaryAction={isActive}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={notice.action === "restart" ? <RotateCcw size={14} /> : <RefreshCw size={14} />}
            onClick={handleReconnect}
            data-testid="terminal-disconnect-reconnect-btn"
            data-action={notice.action}
          >
            {actionLabel}
          </Button>
        }
      >
        {autoReconnectOff && (
          <p
            className="terminal-disconnect-overlay__note"
            data-testid="terminal-disconnect-auto-reconnect-off"
          >
            {autoReconnectOffNote}
          </p>
        )}
      </ContentOverlay>
    </DisconnectStrip>
  );
}
