import type { Terminal as XTerm } from "@xterm/xterm";
import { getAgentSessionBuffer, takeResumedAgentSession } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { isBackendDrivenAgentReconnectTabId } from "@/store/reconnectHelpers";
import { currentSessionView } from "@/store/sessionBridge";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { resumedMarker } from "./dropCopy";
import { NO_REPLAY, type ReplayEnd } from "./scrollbackReplay";

/**
 * Who repaints an agent tab's scrollback after a reconnect (#5953).
 *
 * Only the backend redrive re-attaches a dropped agent tab's live session, and
 * its session daemon then re-forwards the buffer as live output. Every other
 * reconnect — the tab's Reconnect after a user agent Disconnect, a "start new
 * shell" — connects through the client and keeps the tab's own scrollback, so
 * the earlier output and the "connection lost" marker stay above the new
 * session.
 *
 * True when the server supplies the scrollback, so the tab must not replay its
 * local snapshot nor write a reconnect marker (it would land above the replay).
 */
export function backendRedriveSuppliesScrollback(tabId: string): boolean {
  if (!isBackendDrivenAgentReconnectTabId(tabId)) return false;
  if (useAppStore.getState().terminalForceFreshReconnect[tabId]) return false;
  return currentSessionView()[tabId]?.status === "reconnecting";
}

/** What {@link repaintIfResumed} did. */
export interface ResumedRepaint {
  /** Whether the backend resumed the tab's own session. */
  resumed: boolean;
  /** Where the repaint ends in the session's output stream (#5990). */
  replayEnd: ReplayEnd;
}

/**
 * After an agent tab's client reconnect, whether the backend resumed the tab's
 * own session instead of starting a new one (#5953) — and if so, repaint the
 * session's own scrollback (which includes what it printed while detached) and
 * mark the resume below it.
 *
 * The session daemon also re-forwards that buffer as live output on the
 * attach; the caller skips what the repaint holds (`replayEnd`), as a
 * persistent re-attach does.
 */
export async function repaintIfResumed(
  xterm: XTerm,
  sessionId: string,
  resetCommandMarks: () => void,
  isCanceled: () => boolean
): Promise<ResumedRepaint> {
  let resumed = false;
  let replayEnd = NO_REPLAY;
  try {
    resumed = await takeResumedAgentSession(sessionId);
  } catch (err) {
    frontendLog("terminal", `resume check failed for ${sessionId}: ${errorMessage(err)}`);
    return { resumed: false, replayEnd };
  }
  if (!resumed || isCanceled()) return { resumed, replayEnd };
  try {
    const { data, ...end } = await getAgentSessionBuffer(sessionId);
    if (isCanceled()) return { resumed, replayEnd };
    // Also when the buffer is not here yet: it then comes as live output, and
    // the tab's own scrollback above it would be the same history twice.
    // The raw buffer carries the OSC 133 marks: rebuild them, not duplicate.
    resetCommandMarks();
    xterm.reset();
    if (data.length > 0) await new Promise<void>((resolve) => xterm.write(data, resolve));
    replayEnd = end;
  } catch (err) {
    // The tab keeps its own scrollback; only the detached output is missing.
    frontendLog("terminal", `resumed-session buffer failed: ${errorMessage(err)}`);
  }
  xterm.writeln(`\r\n\x1b[90m${resumedMarker(new Date())}\x1b[0m`);
  return { resumed, replayEnd };
}
