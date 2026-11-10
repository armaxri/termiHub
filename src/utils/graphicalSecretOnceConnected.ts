/**
 * Save a typed VNC/RDP password only once its connect has succeeded (#5197).
 *
 * The graphical counterpart of {@link persistSecretOnceConnected} (#5156).
 * A remote-desktop tab never reports a terminal `session-lifecycle` record,
 * so its success signal is its own: `remote_desktop_connect` resolving, which
 * the backend does only once the session is authenticated and active
 * (`useRemoteDesktopSession`). Until then, the write a prompt's Save box asked
 * for is held here in memory, keyed by the tab id:
 *
 * - {@link graphicalConnectSucceeded} runs the held write;
 * - {@link graphicalConnectFailed} (a failed, rejected or canceled connect)
 *   and {@link discardGraphicalSecret} (the tab closed) drop it unsaved;
 * - a write nobody claims within {@link GRAPHICAL_SECRET_TIMEOUT_MS} is
 *   dropped too, so a connect that never settles cannot keep it in memory.
 *
 * Nothing is ever deleted from the credential store here. The secret itself
 * stays inside the held callback's closure and is never logged.
 */
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/** How long a held write waits for its connect (as for terminal tabs). */
export const GRAPHICAL_SECRET_TIMEOUT_MS = 10 * 60_000;

/** How a held write ended. */
export type GraphicalSecretOutcome = "persisted" | "failed" | "discarded";

interface HeldWrite {
  persist: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: GraphicalSecretOutcome) => void;
}

const held = new Map<string, HeldWrite>();

/** Take (and forget) the write held for `tabId`. */
function take(tabId: string): HeldWrite | undefined {
  const entry = held.get(tabId);
  if (!entry) return undefined;
  held.delete(tabId);
  clearTimeout(entry.timer);
  return entry;
}

/** Options for {@link holdGraphicalSecretUntilConnected}. */
export interface HoldGraphicalSecretOptions {
  /** Override {@link GRAPHICAL_SECRET_TIMEOUT_MS} (tests). */
  timeoutMs?: number;
}

/**
 * Hold `persist` until the remote-desktop tab `tabId` connects (see the module
 * docs). Call it right after opening the tab. A write already held for the tab
 * is dropped. The returned promise settles with the outcome and never rejects.
 */
export function holdGraphicalSecretUntilConnected(
  tabId: string,
  persist: () => Promise<void>,
  options: HoldGraphicalSecretOptions = {}
): Promise<GraphicalSecretOutcome> {
  take(tabId)?.resolve("discarded");
  return new Promise<GraphicalSecretOutcome>((resolve) => {
    const timer = setTimeout(() => {
      if (held.get(tabId)?.timer === timer) take(tabId)?.resolve("discarded");
    }, options.timeoutMs ?? GRAPHICAL_SECRET_TIMEOUT_MS);
    held.set(tabId, { persist, timer, resolve });
  });
}

/** The tab's connect succeeded: run the write held for it, if any. */
export function graphicalConnectSucceeded(tabId: string): void {
  const entry = take(tabId);
  if (!entry) return;
  entry.persist().then(
    () => entry.resolve("persisted"),
    (err: unknown) => {
      frontendLog(
        "graphical_secret",
        `Failed to store remote-desktop password: ${errorMessage(err)}`
      );
      entry.resolve("failed");
    }
  );
}

/** The tab's connect failed, was rejected or was canceled: drop its write. */
export function graphicalConnectFailed(tabId: string): void {
  take(tabId)?.resolve("discarded");
}

/** The tab closed: drop its write unsaved. */
export function discardGraphicalSecret(tabId: string): void {
  take(tabId)?.resolve("discarded");
}

/** Whether a write is held for `tabId` (tests and diagnostics). */
export function hasHeldGraphicalSecret(tabId: string): boolean {
  return held.has(tabId);
}
