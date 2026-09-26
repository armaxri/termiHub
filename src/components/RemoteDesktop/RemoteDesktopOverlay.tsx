import { RefreshCw, AlertCircle, Power } from "lucide-react";
import { Button, Spinner, ContentOverlay } from "@/components/ui";
import type { GraphicalSessionState } from "@/types/remoteDesktop";
import { MAX_RECONNECT_ATTEMPTS } from "@/types/remoteDesktop";

interface RemoteDesktopOverlayProps {
  state: GraphicalSessionState;
  host: string;
  reconnectAttempt: number;
  message: string | null;
  /** Cancel an in-progress auto-reconnect (tears the session down). */
  onCancel: () => void;
  /** Manually (re)connect from a failed / dropped state. */
  onReconnect: () => void;
}

/**
 * The one shared set of connection-state overlays for graphical remote-desktop
 * sessions (#1680): connecting, reconnecting (with attempt counter + Cancel)
 * while the backend auto-reconnect loop is retrying (#3364), and the
 * dropped / auth / connect / close resting states (with a Reconnect action).
 * `disconnected` means no retry is running — Auto-Reconnect is off, its budget
 * is spent, or the drop was non-retryable — so it gets the manual prompt. Returns
 * `null` while the session is active so the canvas shows through.
 */
export function RemoteDesktopOverlay({
  state,
  host,
  reconnectAttempt,
  message,
  onCancel,
  onReconnect,
}: RemoteDesktopOverlayProps) {
  if (state === "active" || state === "resizing") return null;

  if (state === "connecting" || state === "authenticating") {
    return (
      <div className="rd-overlay" data-testid="remote-desktop-overlay-connecting">
        <ContentOverlay
          icon={<Spinner size="lg" label={null} className="rd-overlay__icon" />}
          heading={`Connecting to ${host}…`}
          subheading={state === "authenticating" ? "Authenticating" : "Establishing connection"}
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
          heading="Connection lost. Reconnecting…"
          subheading={`attempt ${Math.max(reconnectAttempt, 1)}/${MAX_RECONNECT_ATTEMPTS}`}
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
        heading={
          state === "authFailed"
            ? "Authentication failed"
            : state === "connectFailed"
              ? "Could not connect"
              : state === "serverClosed"
                ? "Session closed by server"
                : state === "disconnected"
                  ? "Connection lost"
                  : "Disconnected"
        }
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
        {message && <div className="rd-overlay__sub rd-overlay__error">{message}</div>}
        {state === "authFailed" && (
          <div className="rd-overlay__sub">Check the credentials and try again.</div>
        )}
      </ContentOverlay>
    </div>
  );
}
