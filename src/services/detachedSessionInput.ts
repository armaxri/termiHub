/**
 * Fire-and-forget terminal input that can never leave an unhandled rejection
 * (#5384).
 *
 * Much of what reaches `send_input` is not awaited by anyone: keystrokes and
 * xterm's own replies (focus reports, cursor-position and device-attribute
 * answers) from `onData`, broadcast fan-out, a workspace's initial command, a
 * paste or file drop. Such input can race the session's teardown — on Windows
 * ConPTY enables focus reporting, so a split or a panel close emits a focus
 * report to a session that a tab close already dropped — and the invoke then
 * rejects with `session_not_found` or `write_failed` ("session disconnected").
 *
 * {@link sendInputDetached} delivers the input and settles to whether it was
 * delivered. A rejection because the session already ended is expected and is
 * only traced at DEBUG: the session's exit / disconnect path owns telling the
 * user. Any other failure is a genuine error on a live session and is surfaced
 * through {@link frontendError}.
 */

import { sendInput } from "@/services/api";
import type { SessionId } from "@/types/terminal";
import { isSessionEndedError, parseBackendError } from "@/utils/backendErrorCode";
import { frontendError, frontendLog } from "@/utils/frontendLog";

/**
 * Send `data` to `sessionId` without the caller awaiting it.
 *
 * Never rejects. Resolves `true` when the backend accepted the input, `false`
 * when it was dropped — the session had already ended (traced at DEBUG) or the
 * write genuinely failed (logged as an ERROR). `reason` names the call site in
 * the log (e.g. "typed input", "broadcast input").
 */
export async function sendInputDetached(
  sessionId: SessionId,
  data: string,
  reason: string
): Promise<boolean> {
  try {
    await sendInput(sessionId, data);
    return true;
  } catch (err) {
    const { code, message } = parseBackendError(err);
    if (isSessionEndedError(err)) {
      frontendLog(
        "terminal",
        `${reason} dropped: session ${sessionId} already ended (${code}: ${message})`
      );
    } else {
      frontendError(
        "terminal",
        `${reason} to session ${sessionId} failed: ${code ? `${code}: ` : ""}${message}`
      );
    }
    return false;
  }
}
