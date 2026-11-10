/**
 * Helpers for the saved-credential **pre-connect** (#5180): the window between
 * a click on a saved connection and its tab, in which
 * {@link import("@/utils/connectSavedConnection").connectSavedConnection}
 * unlocks the credential store, resolves the stored secret and validates it
 * with a blocking connect.
 *
 * - {@link untilAborted} lets each step of that window be abandoned the moment
 *   the user presses Abort, handing a result that arrives afterwards to a
 *   cleanup callback instead of the flow.
 * - {@link runPreconnect} runs the pre-connect itself under its own connect
 *   id, reporting its stages and closing a session that arrives after Abort.
 * - {@link preconnectStageText} turns a backend `connect-progress` stage into
 *   the one-line stage readout the "Connecting…" toast shows.
 * - {@link stashPreconnectFailure} / {@link takePreconnectFailure} hand a failed
 *   pre-connect's error to the tab opened for it, so the tab shows that
 *   failure instead of connecting a second time.
 */
import { closeTerminal, createTerminal } from "@/services/api";
import { onConnectProgress } from "@/services/events";
import type { ConnectStage } from "@/types/generated/ConnectStage";
import type { ConnectionConfig } from "@/types/terminal";
import { stepLabel, stepsFor } from "@/utils/connectStages";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/** What {@link untilAborted} resolves to once the signal aborted first. */
export const PRECONNECT_ABORTED: unique symbol = Symbol("preconnect-aborted");

/**
 * Resolve with `promise`'s value — or with {@link PRECONNECT_ABORTED} as soon
 * as `signal` aborts, whichever comes first. A value that arrives after the
 * abort goes to `onLate` (e.g. to close a session nobody will use); a late
 * rejection is dropped, since nobody is waiting for it any more.
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLate?: (value: T) => void
): Promise<T | typeof PRECONNECT_ABORTED> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve(PRECONNECT_ABORTED);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          onLate?.(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(err);
      }
    );
  });
}

/**
 * The toast's stage readout for a `connect-progress` report, e.g.
 * `"Authenticate (4 of 5)"`; just the label for a stage the connection type
 * does not list.
 */
export function preconnectStageText(sessionType: string, stage: ConnectStage): string {
  const steps = stepsFor(sessionType);
  const at = steps.indexOf(stage);
  const label = stepLabel(stage);
  return at < 0 ? label : `${label} (${at + 1} of ${steps.length})`;
}

/** Pre-connect failures waiting for their tab to mount, by tab id. */
const pendingFailures = new Map<string, unknown>();

/**
 * Hand `error` — the failed pre-connect's rejection — to the tab `tabId` that
 * was opened to show it (#5180). The tab takes it on its first connect and
 * lands on that failure (with Retry) instead of connecting again.
 */
export function stashPreconnectFailure(tabId: string, error: unknown): void {
  pendingFailures.set(tabId, error);
}

/**
 * Take (and forget) the pre-connect failure stashed for `tabId`. `found` is
 * `false` when there is none, so the tab connects as usual.
 */
export function takePreconnectFailure(
  tabId: string
): { found: true; error: unknown } | { found: false } {
  if (!pendingFailures.has(tabId)) return { found: false };
  const error = pendingFailures.get(tabId);
  pendingFailures.delete(tabId);
  return { found: true, error };
}

/** Callbacks {@link runPreconnect} reports through. */
export interface PreconnectHooks {
  /** The backend connect started under this connect id (cancel it by that id). */
  started: (connectId: string) => void;
  /** The connect reached a new stage; `text` is the toast's stage readout. */
  stage: (text: string) => void;
}

/**
 * The stored-credential pre-connect (#5180): `createTerminal` under its own
 * connect id, so Abort can cancel it and its `connect-progress` stages can be
 * shown. Resolves {@link PRECONNECT_ABORTED} once `signal` aborts; a session
 * that still comes up after that is closed, never adopted. The id carries no
 * `${tabId}:${n}` form, so the backend folds no tab lifecycle for it.
 */
export async function runPreconnect(
  config: ConnectionConfig,
  savedConnectionId: string,
  signal: AbortSignal,
  hooks: PreconnectHooks
): Promise<string | typeof PRECONNECT_ABORTED> {
  const connectId = `preconnect-${crypto.randomUUID()}`;
  const sessionType = config.type === "remote-session" ? "" : config.type;
  let unlisten: (() => void) | null = null;
  try {
    unlisten = await onConnectProgress((event) => {
      if (event.connectId === connectId) {
        hooks.stage(preconnectStageText(sessionType, event.stage));
      }
    });
  } catch (err) {
    // A display feed only: the connect runs without it.
    frontendLog("connection_list", `connect-progress unavailable: ${errorMessage(err)}`);
  }
  if (signal.aborted) {
    unlisten?.();
    return PRECONNECT_ABORTED;
  }
  hooks.started(connectId);
  try {
    return await untilAborted(
      createTerminal(config, connectId, undefined, undefined, undefined, savedConnectionId),
      signal,
      (lateSession) => {
        frontendLog("connection_list", `closing session ${lateSession} that started after Abort`);
        void closeTerminal(lateSession).catch((err: unknown) =>
          frontendLog("connection_list", `close of ${lateSession} failed: ${errorMessage(err)}`)
        );
      }
    );
  } finally {
    unlisten?.();
  }
}
