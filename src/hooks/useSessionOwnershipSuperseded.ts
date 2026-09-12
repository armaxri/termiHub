import { useEffect } from "react";
import { onSessionOwnershipSuperseded } from "@/services/events";
import { toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Global hook that explains a silent loss of resize rights (SM-026).
 *
 * Session ownership is single-owner by design: when two windows render the same
 * session, the last to `claim` it owns the PTY size and the losing window's
 * `resize` calls are denied by the backend `may_resize` guard. Previously the
 * losing window got no signal — the user saw a terminal that inexplicably would
 * not resize. The backend now pushes a targeted `session-ownership-superseded`
 * event to that window; this hook surfaces it as a neutral toast so the denial is
 * explained.
 *
 * Mounted once at the app root. This does not change ownership/resize semantics —
 * it only makes the transition observable to the user.
 */
export function useSessionOwnershipSuperseded(): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    onSessionOwnershipSuperseded((payload) => {
      frontendLog(
        "session_ownership",
        `session ${payload.sessionId} claimed by ${payload.newOwner}; resize disabled in this window`
      );
      toast.info("This session is now controlled by another window — resize is disabled here.");
    })
      .then((fn) => {
        // If the effect tore down before registration resolved, unlisten
        // immediately so the listener does not leak past the hook's life
        // (FEC-017).
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) =>
        frontendLog("session_ownership", `Failed to subscribe to superseded events: ${err}`)
      );

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
