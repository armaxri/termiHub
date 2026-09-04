import { Loader2, RefreshCw, AlertCircle, Power } from "lucide-react";
import { Button } from "@/components/ui";
import type { GraphicalSessionState } from "@/types/remoteDesktop";
import { MAX_RECONNECT_ATTEMPTS } from "@/types/remoteDesktop";

interface RemoteDesktopOverlayProps {
  state: GraphicalSessionState;
  host: string;
  reconnectAttempt: number;
  message: string | null;
  /** Cancel an in-progress reconnect (tears the session down). */
  onCancel: () => void;
  /** Manually (re)connect from a failed / dropped state. */
  onReconnect: () => void;
}

/**
 * The one shared set of connection-state overlays for graphical remote-desktop
 * sessions (#1680): connecting, reconnecting (with attempt counter + Cancel),
 * and the auth/connect/close failure states (with a Reconnect action). Returns
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
        <Loader2 size={30} className="rd-overlay__icon rd-overlay__spin motion-essential-spinner" />
        <div className="rd-overlay__title">Connecting to {host}…</div>
        <div className="rd-overlay__sub">
          {state === "authenticating" ? "Authenticating" : "Establishing connection"}
        </div>
      </div>
    );
  }

  if (state === "reconnecting" || state === "disconnected") {
    return (
      <div className="rd-overlay" data-testid="remote-desktop-overlay-reconnecting">
        <RefreshCw
          size={30}
          className="rd-overlay__icon rd-overlay__spin motion-essential-spinner"
        />
        <div className="rd-overlay__title">Connection lost. Reconnecting…</div>
        <div className="rd-overlay__sub">
          attempt {Math.max(reconnectAttempt, 1)}/{MAX_RECONNECT_ATTEMPTS}
        </div>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }

  // Failure / closed states: auth failed, connect failed, server closed, closed.
  const closed = state === "serverClosed" || state === "closed";
  return (
    <div className="rd-overlay" data-testid="remote-desktop-overlay-error">
      {closed ? (
        <Power size={30} className="rd-overlay__icon" />
      ) : (
        <AlertCircle size={30} className="rd-overlay__icon rd-overlay__icon--error" />
      )}
      <div className="rd-overlay__title">
        {state === "authFailed"
          ? "Authentication failed"
          : state === "connectFailed"
            ? "Could not connect"
            : state === "serverClosed"
              ? "Session closed by server"
              : "Disconnected"}
      </div>
      {message && <div className="rd-overlay__sub rd-overlay__error">{message}</div>}
      {state === "authFailed" && (
        <div className="rd-overlay__sub">Check the credentials and try again.</div>
      )}
      <Button
        variant="secondary"
        size="sm"
        onClick={onReconnect}
        data-testid="remote-desktop-reconnect"
      >
        Reconnect
      </Button>
    </div>
  );
}
