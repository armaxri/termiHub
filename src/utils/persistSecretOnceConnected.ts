/**
 * Persist a typed secret only once the connect it was typed for has succeeded
 * (#5156, UX-002).
 *
 * A password or key passphrase the user typed into a connect-time prompt (or
 * the credential re-entry form) used to be written to the credential store
 * *before* the connect ran, so a typo was saved and then replaced the next
 * time. This helper holds the secret in memory instead and runs the write only
 * when the tab's session reaches the established stage: the projected
 * `session-lifecycle` region (keyed by tab id) reports it `connected` and not
 * exited. Every other outcome — an auth rejection, a failed connect, a lost
 * session, the tab closing, or no answer within
 * {@link PERSIST_AFTER_CONNECT_TIMEOUT_MS} — discards the secret unsaved.
 *
 * The secret itself never leaves the `persist` callback's closure; nothing
 * here logs it.
 */
import {
  currentSessionView,
  ensureSessionSubscribed,
  logSessionBridgeFallback,
  onSessionView,
  type ProjectedSessionLifecycle,
} from "@/store/sessionBridge";

/**
 * How long a typed secret waits for its connect before it is discarded. Long
 * enough for a slow handshake with a host-key decision and a second factor;
 * bounded so a connect that never settles cannot keep the secret in memory.
 */
export const PERSIST_AFTER_CONNECT_TIMEOUT_MS = 10 * 60_000;

/** How a {@link persistSecretOnceConnected} wait ended. */
export type PersistOnceConnectedOutcome =
  /** The session was established and the secret was written. */
  | "persisted"
  /** The session was established but the write itself failed. */
  | "failed"
  /** The connect did not succeed (or never settled): nothing was written. */
  | "discarded";

/** Session states that end a connect attempt without an established session. */
const UNSUCCESSFUL: ReadonlySet<ProjectedSessionLifecycle["status"]> = new Set([
  "failed",
  "authFailed",
  "sessionLost",
  "disconnected",
  "evicted",
]);

/** Session states that mean a connect attempt is under way. */
const IN_FLIGHT: ReadonlySet<ProjectedSessionLifecycle["status"]> = new Set([
  "connecting",
  "reconnecting",
]);

/** Options for {@link persistSecretOnceConnected}. */
export interface PersistOnceConnectedOptions {
  /** Override {@link PERSIST_AFTER_CONNECT_TIMEOUT_MS} (tests). */
  timeoutMs?: number;
}

/**
 * Wait for `tabId`'s connect to settle and run `persist` only if it reached an
 * established session (see the module docs). Never rejects.
 *
 * Call it right after starting the connect. A tab that already shows an
 * unsuccessful state (the `authFailed` tab a re-entry reconnects) is not read
 * as this attempt's outcome: a failure counts only once a new attempt was seen
 * in flight, or when the tab had no session record at all when the wait began.
 */
export function persistSecretOnceConnected(
  tabId: string,
  persist: () => Promise<void>,
  options: PersistOnceConnectedOptions = {}
): Promise<PersistOnceConnectedOutcome> {
  const timeoutMs = options.timeoutMs ?? PERSIST_AFTER_CONNECT_TIMEOUT_MS;
  const freshTab = currentSessionView()[tabId] === undefined;
  let attemptSeen = false;

  /** `true` = established, `false` = unsuccessful, `null` = not settled yet. */
  const classify = (life: ProjectedSessionLifecycle | undefined): boolean | null => {
    if (!life) {
      // The record vanished after the attempt started: the tab was closed.
      return attemptSeen ? false : null;
    }
    if (life.status === "connected" && life.exit === undefined) return true;
    if (IN_FLIGHT.has(life.status)) {
      attemptSeen = true;
      return null;
    }
    if (UNSUCCESSFUL.has(life.status) || life.exit !== undefined) {
      return attemptSeen || freshTab ? false : null;
    }
    return null;
  };

  return new Promise<PersistOnceConnectedOutcome>((resolve) => {
    let settled = false;

    const finish = (established: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      if (!established) {
        resolve("discarded");
        return;
      }
      persist().then(
        () => resolve("persisted"),
        () => resolve("failed")
      );
    };

    // `finish` runs only from a later diff, the timer or the checks below, so
    // both handles are always assigned before it reads them.
    const unsubscribe = onSessionView((next) => {
      const outcome = classify(next[tabId]);
      if (outcome !== null) finish(outcome);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);

    // A subscribe failure is logged by the bridge; keep waiting — the timeout
    // bounds the wait, and an unsaved secret is the safe outcome.
    Promise.resolve()
      .then(ensureSessionSubscribed)
      .catch((err: unknown) => logSessionBridgeFallback("subscribe", err));

    const immediate = classify(currentSessionView()[tabId]);
    // A record already `connected` belongs to this attempt only for a tab the
    // wait was started on before any record existed; otherwise wait for a diff.
    if (immediate === true && !freshTab) return;
    if (immediate !== null) finish(immediate);
  });
}
