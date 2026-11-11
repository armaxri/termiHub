import { useId, useRef, type ReactNode } from "react";
import { AlertCircle, Power, Ban, Monitor, X } from "lucide-react";
import { Button, ContentOverlay } from "@/components/ui";
import { ConnectProgress, type ConnectStage } from "@/components/ui/ConnectProgress";
import { connectTypeLabel } from "@/utils/connectStages";
import type { GraphicalSessionState } from "@/types/remoteDesktop";
import { MAX_RECONNECT_ATTEMPTS } from "@/types/remoteDesktop";
import { RECONNECTING_HEADING, reconnectAttemptLabel } from "@/utils/reconnectStatus";
import { ABORTED_CONNECT_MESSAGE } from "@/store/reconnectHelpers";
import {
  backendFamilyFromSessionType,
  connectionErrorHint,
  isNetworkErrorKind,
  type ConnectionErrorKind,
} from "@/utils/connectionErrorHints";
import { getPlatform } from "@/utils/platform";
import {
  ConnectErrorDetails,
  ConnectFailureActions,
  ConnectFailureHint,
  restingConnectHeading,
  restingConnectPhase,
} from "@/components/Terminal/ConnectFailure";

interface RemoteDesktopOverlayProps {
  state: GraphicalSessionState;
  host: string;
  /** `"rdp"` or `"vnc"`, for the type chip. */
  protocol?: string;
  reconnectAttempt: number;
  message: string | null;
  /** Cancel an in-progress auto-reconnect (tears the session down). */
  onCancel: () => void;
  /** Abort the initial connect while connecting / authenticating (#4298). */
  onCancelConnect: () => void;
  /** Manually (re)connect from a failed / dropped state. */
  onReconnect: () => void;
  /** Close the tab (#5377). */
  onCloseTab: () => void;
  /**
   * Open the saved connection's editor from a failed connect (#5377);
   * omitted for a tab not opened from a saved connection.
   */
  onEditConnection?: () => void;
  /** Typed category of a failed connect (#5377). */
  errorKind?: ConnectionErrorKind;
  /** The user aborted the connect or reconnect (#5377). */
  aborted?: boolean;
  /** Inline credential re-entry, shown on an auth failure (#5377). */
  credentialReentry?: ReactNode;
  /**
   * Whether this tab is the active (visible) one. Moves focus to **Reconnect**
   * when a resting failure / closed state appears (#4514); background tabs
   * never steal focus.
   */
  isActive?: boolean;
}

/** The resting-state heading for a dropped or closed session. */
function restingHeading(state: GraphicalSessionState): string {
  switch (state) {
    case "serverClosed":
      return "Session ended by the server";
    case "disconnected":
      return "Connection lost";
    default:
      return "Disconnected";
  }
}

/** The graphical connect steps: Connect → Authenticate → Desktop (#5068). */
function graphicalStages(state: GraphicalSessionState): ConnectStage[] {
  const at = state === "authenticating" ? 1 : 0;
  return ["Connect", "Authenticate", "Desktop"].map((label, i) => ({
    id: label.toLowerCase(),
    label,
    state: i < at ? "done" : i === at ? "active" : "pending",
  }));
}

/**
 * The one shared set of connection-state overlays for graphical remote-desktop
 * sessions (#1680): connecting (with Cancel, #4298), reconnecting (with attempt counter + Cancel)
 * while the backend auto-reconnect loop is retrying (#3364) — worded like a
 * terminal tab's reconnect (#3730: "Connection lost — reconnecting…",
 * "Attempt n of N") — a failed or aborted connect, which rests on the
 * terminal's failure screen (#5377: humanised reason, Retry, Edit connection,
 * Close tab, and credential re-entry for a rejected password) — and the
 * dropped / close resting states (Reconnect and Close tab).
 * `disconnected` means no retry is running — Auto-Reconnect is off, its budget
 * is spent, or the drop was non-retryable — so it gets the manual prompt.
 * `serverClosed` means the server ended the session on purpose (a remote logoff
 * or an admin disconnect, #4321): never auto-reconnected, manual prompt. Returns
 * `null` while the session is active so the canvas shows through.
 */
export function RemoteDesktopOverlay({
  state,
  host,
  protocol = "rdp",
  reconnectAttempt,
  message,
  onCancel,
  onCancelConnect,
  onReconnect,
  onCloseTab,
  onEditConnection,
  errorKind = "other",
  aborted = false,
  credentialReentry,
  isActive = false,
}: RemoteDesktopOverlayProps) {
  const messageId = useId();
  // The ring's elapsed readout counts from when this overlay first showed.
  const startedAt = useRef(Date.now()).current;
  if (state === "active" || state === "resizing") return null;

  const common = {
    target: host,
    typeLabel: connectTypeLabel(protocol),
    typeIcon: <Monitor size={20} aria-hidden />,
    startedAt,
  };

  if (state === "connecting" || state === "authenticating") {
    const status = state === "authenticating" ? "Authenticating" : "Establishing connection";
    return (
      <div className="rd-overlay" data-testid="remote-desktop-overlay-connecting">
        <ConnectProgress
          {...common}
          phase="connecting"
          heading={`Connecting to ${host}…`}
          stages={graphicalStages(state)}
          status={status}
          announcement={`Connecting to ${host}… ${status}`}
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon={<Ban size={14} />}
              onClick={onCancelConnect}
              data-testid="remote-desktop-cancel-connect"
            >
              Abort
            </Button>
          }
        />
      </div>
    );
  }

  if (state === "reconnecting") {
    const attempt = reconnectAttemptLabel(reconnectAttempt, MAX_RECONNECT_ATTEMPTS);
    return (
      <div className="rd-overlay" data-testid="remote-desktop-overlay-reconnecting">
        <ConnectProgress
          {...common}
          phase="retrying"
          heading={RECONNECTING_HEADING}
          attempt={{ current: Math.max(1, reconnectAttempt), max: MAX_RECONNECT_ATTEMPTS }}
          announcement={`${RECONNECTING_HEADING} ${attempt}`}
          actions={
            <Button variant="secondary" size="sm" icon={<Ban size={14} />} onClick={onCancel}>
              Abort
            </Button>
          }
        />
      </div>
    );
  }

  // A failed or user-aborted connect rests on the terminal's failure screen
  // (#5377): humanised reason, Retry, Edit connection and Close tab.
  if (state === "connectFailed" || state === "authFailed" || (state === "closed" && aborted)) {
    const kind: ConnectionErrorKind = state === "authFailed" ? "auth" : errorKind;
    const phase = restingConnectPhase(state === "closed", kind);
    const heading = restingConnectHeading(phase, kind);
    const error = phase === "aborted" ? ABORTED_CONNECT_MESSAGE : (message ?? "");
    const networkFailure = phase === "failed" && isNetworkErrorKind(kind) && error !== "";
    const hint =
      phase === "aborted"
        ? null
        : connectionErrorHint(backendFamilyFromSessionType(protocol), kind, getPlatform());
    return (
      <div className="rd-overlay" data-testid="remote-desktop-overlay-error">
        <ConnectProgress
          {...common}
          phase={phase}
          heading={heading}
          error={networkFailure || !error ? undefined : error}
          announcement={[`${heading}.`, `${host}:`, error].join(" ").trim()}
          autoFocusPrimaryAction={isActive}
          timeText=""
          actions={
            <ConnectFailureActions
              onRetry={onReconnect}
              onEdit={phase === "aborted" ? undefined : onEditConnection}
              onClose={onCloseTab}
              testIds={{
                retry: "remote-desktop-retry",
                edit: "remote-desktop-edit",
                close: "remote-desktop-close-tab",
              }}
            />
          }
        >
          <ConnectFailureHint hint={hint} />
          {networkFailure && <ConnectErrorDetails error={error} />}
          {kind === "auth" && credentialReentry}
        </ConnectProgress>
      </div>
    );
  }

  // Resting states of a session that was up: dropped (no retry running),
  // server closed, closed.
  const closed = state === "serverClosed" || state === "closed";
  const heading = restingHeading(state);
  return (
    <div className="rd-overlay" data-testid="remote-desktop-overlay-error">
      <ContentOverlay
        icon={
          closed ? (
            <Power size={30} className="rd-overlay__icon" />
          ) : (
            <AlertCircle size={30} className="rd-overlay__icon rd-overlay__icon--error" />
          )
        }
        heading={heading}
        // Failures the user must act on interrupt; an intentional close
        // (server logoff, closed) is a polite state change (#4514).
        announce={closed ? "polite" : "assertive"}
        announcement={[`${heading}.`, message].filter(Boolean).join(" ")}
        describedBy={message ? messageId : undefined}
        autoFocusPrimaryAction={isActive}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={onReconnect}
              data-testid="remote-desktop-reconnect"
            >
              Reconnect
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<X size={14} />}
              onClick={onCloseTab}
              data-testid="remote-desktop-close-tab"
            >
              Close tab
            </Button>
          </>
        }
      >
        {message && (
          <div id={messageId} className="rd-overlay__sub rd-overlay__error">
            {message}
          </div>
        )}
      </ContentOverlay>
    </div>
  );
}
