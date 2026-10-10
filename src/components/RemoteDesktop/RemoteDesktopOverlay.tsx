import { useId } from "react";
import { RefreshCw, AlertCircle, Power } from "lucide-react";
import { Button, Spinner, ContentOverlay } from "@/components/ui";
import type { GraphicalSessionState } from "@/types/remoteDesktop";
import { MAX_RECONNECT_ATTEMPTS } from "@/types/remoteDesktop";
import { RECONNECTING_HEADING, reconnectAttemptLabel } from "@/utils/reconnectStatus";

interface RemoteDesktopOverlayProps {
  state: GraphicalSessionState;
  host: string;
  reconnectAttempt: number;
  message: string | null;
  /** Cancel an in-progress auto-reconnect (tears the session down). */
  onCancel: () => void;
  /** Abort the initial connect while connecting / authenticating (#4298). */
  onCancelConnect: () => void;
  /** Manually (re)connect from a failed / dropped state. */
  onReconnect: () => void;
  /**
   * Whether this tab is the active (visible) one. Moves focus to **Reconnect**
   * when a resting failure / closed state appears (#4514); background tabs
   * never steal focus.
   */
  isActive?: boolean;
}

/** The resting-state heading for each non-busy state. */
function restingHeading(state: GraphicalSessionState): string {
  switch (state) {
    case "authFailed":
      return "Authentication failed";
    case "connectFailed":
      return "Could not connect";
    case "serverClosed":
      return "Session ended by the server";
    case "disconnected":
      return "Connection lost";
    default:
      return "Disconnected";
  }
}

/**
 * The one shared set of connection-state overlays for graphical remote-desktop
 * sessions (#1680): connecting (with Cancel, #4298), reconnecting (with attempt counter + Cancel)
 * while the backend auto-reconnect loop is retrying (#3364) — worded like a
 * terminal tab's reconnect (#3730: "Connection lost — reconnecting…",
 * "Attempt n of N") — and the
 * dropped / auth / connect / close resting states (with a Reconnect action).
 * `disconnected` means no retry is running — Auto-Reconnect is off, its budget
 * is spent, or the drop was non-retryable — so it gets the manual prompt.
 * `serverClosed` means the server ended the session on purpose (a remote logoff
 * or an admin disconnect, #4321): never auto-reconnected, manual prompt. Returns
 * `null` while the session is active so the canvas shows through.
 */
export function RemoteDesktopOverlay({
  state,
  host,
  reconnectAttempt,
  message,
  onCancel,
  onCancelConnect,
  onReconnect,
  isActive = false,
}: RemoteDesktopOverlayProps) {
  const messageId = useId();
  const hintId = useId();
  if (state === "active" || state === "resizing") return null;

  if (state === "connecting" || state === "authenticating") {
    return (
      <div className="rd-overlay" data-testid="remote-desktop-overlay-connecting">
        <ContentOverlay
          icon={<Spinner size="lg" label={null} className="rd-overlay__icon" />}
          busy
          heading={`Connecting to ${host}…`}
          subheading={state === "authenticating" ? "Authenticating" : "Establishing connection"}
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={onCancelConnect}
              data-testid="remote-desktop-cancel-connect"
            >
              Cancel
            </Button>
          }
        />
      </div>
    );
  }

  if (state === "reconnecting") {
    return (
      <div className="rd-overlay" data-testid="remote-desktop-overlay-reconnecting">
        <ContentOverlay
          icon={
            <RefreshCw
              size={30}
              className="rd-overlay__icon rd-overlay__spin motion-essential-spinner"
            />
          }
          busy
          heading={RECONNECTING_HEADING}
          subheading={reconnectAttemptLabel(reconnectAttempt, MAX_RECONNECT_ATTEMPTS)}
          actions={
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          }
        />
      </div>
    );
  }

  // Resting states: dropped (no retry running), auth failed, connect failed,
  // server closed, closed.
  const closed = state === "serverClosed" || state === "closed";
  const heading = restingHeading(state);
  const authHint = state === "authFailed" ? "Check the credentials and try again." : null;
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
        announcement={[`${heading}.`, message, authHint].filter(Boolean).join(" ")}
        describedBy={
          [message ? messageId : "", authHint ? hintId : ""].filter(Boolean).join(" ") || undefined
        }
        autoFocusPrimaryAction={isActive}
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={onReconnect}
            data-testid="remote-desktop-reconnect"
          >
            Reconnect
          </Button>
        }
      >
        {message && (
          <div id={messageId} className="rd-overlay__sub rd-overlay__error">
            {message}
          </div>
        )}
        {authHint && (
          <div id={hintId} className="rd-overlay__sub">
            {authHint}
          </div>
        )}
      </ContentOverlay>
    </div>
  );
}
