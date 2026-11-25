import type { Terminal as XTerm } from "@xterm/xterm";
import { getAgentSessionBuffer, takeResumedAgentSession } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { isBackendDrivenAgentReconnectTabId } from "@/store/reconnectHelpers";
import { currentSessionView } from "@/store/sessionBridge";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { resumedMarker } from "./dropCopy";
import { NO_REPLAY, type ReplayEnd } from "./scrollbackReplay";
import { trackUserInput } from "./xtermUserInput";

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
  /**
   * What the user typed since the read of the session's buffer began, ending
   * its collection. The caller sends it when it wires the tab to the session.
   */
  takeTyped: () => string[];
  /**
   * Set when the buffer has not arrived here yet and comes as live output: run
   * it right before the first of that output, which replaces the scrollback.
   */
  beforeFirstOutput: (() => void) | null;
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
 *
 * The tab's own scrollback stays until something replaces it: a session that
 * keeps no buffer, ended meanwhile, or whose buffer could not be read leaves it
 * alone (#5990).
 */
export async function repaintIfResumed(
  xterm: XTerm,
  sessionId: string,
  resetCommandMarks: () => void,
  signal: AbortSignal
): Promise<ResumedRepaint> {
  const isCanceled = () => signal.aborted;
  const repaint: ResumedRepaint = {
    resumed: false,
    replayEnd: NO_REPLAY,
    takeTyped: () => [],
    beforeFirstOutput: null,
  };
  try {
    repaint.resumed = await takeResumedAgentSession(sessionId);
  } catch (err) {
    frontendLog("terminal", `resume check failed for ${sessionId}: ${errorMessage(err)}`);
    return repaint;
  }
  if (!repaint.resumed || isCanceled()) return repaint;
  const writeMarker = () => xterm.writeln(`\r\n\x1b[90m${resumedMarker(new Date())}\x1b[0m`);
  // The raw buffer carries the OSC 133 marks: rebuild them, not duplicate.
  const clear = () => {
    resetCommandMarks();
    xterm.reset();
  };
  repaint.takeTyped = collectTyped(xterm, signal);
  try {
    const { data, coming, ...end } = await getAgentSessionBuffer(sessionId);
    if (isCanceled()) return repaint;
    if (data.length > 0) {
      clear();
      await new Promise<void>((resolve) => xterm.write(data, resolve));
      repaint.replayEnd = end;
    } else if (coming) {
      repaint.beforeFirstOutput = () => {
        clear();
        writeMarker();
      };
    }
  } catch (err) {
    // The tab keeps its own scrollback; only the detached output is missing.
    frontendLog("terminal", `resumed-session buffer failed: ${errorMessage(err)}`);
  }
  writeMarker();
  return repaint;
}

/**
 * Collect what the user types until the returned function takes it. xterm's
 * answers to queries in the repainted buffer are not typed and stay out.
 */
function collectTyped(xterm: XTerm, signal: AbortSignal): () => string[] {
  const typed: string[] = [];
  const userInput = trackUserInput(xterm);
  const data = xterm.onData((text) => {
    if (userInput.take()) typed.push(text);
  });
  const stop = () => {
    data.dispose();
    userInput.dispose();
  };
  signal.addEventListener("abort", stop, { once: true });
  return () => {
    stop();
    return typed;
  };
}
