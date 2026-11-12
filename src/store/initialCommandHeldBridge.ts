import { create } from "zustand";
import { onInitialCommandHeld, type InitialCommandHeldEvent } from "@/services/events";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

/** A held initial command's notice: shown, or dismissed by the user. */
export type InitialCommandHeldState = "held" | "dismissed";

interface InitialCommandHeldStore {
  /** Sessions whose initial command is held, keyed by session id. */
  bySession: Record<string, InitialCommandHeldState>;
}

/**
 * Sessions whose initial command waits for a prompt the shell never announced
 * (#5509), fed by the backend's `initial-command-held` events. Runtime-only and
 * outside the app store: a pure display feed for the tab's notice.
 */
export const useInitialCommandHeldStore = create<InitialCommandHeldStore>(() => ({
  bySession: {},
}));

/** Forget a session's held command (sent, or the session closed). */
export function clearInitialCommandHeld(sessionId: string): void {
  useInitialCommandHeldStore.setState((s) => {
    if (!(sessionId in s.bySession)) return s;
    const { [sessionId]: _dropped, ...rest } = s.bySession;
    return { bySession: rest };
  });
}

/** Fold one `initial-command-held` event into the per-session map. */
export function recordInitialCommandHeld(event: InitialCommandHeldEvent): void {
  if (!event.held) {
    clearInitialCommandHeld(event.sessionId);
    return;
  }
  useInitialCommandHeldStore.setState((s) => ({
    bySession: { ...s.bySession, [event.sessionId]: "held" },
  }));
}

/** Hide a session's notice; the command stays held and is never sent on its own. */
export function dismissInitialCommandHeld(sessionId: string): void {
  useInitialCommandHeldStore.setState((s) =>
    s.bySession[sessionId] === "held"
      ? { bySession: { ...s.bySession, [sessionId]: "dismissed" } }
      : s
  );
}

/** Whether `sessionId`'s held notice should show. */
export function useInitialCommandHeldNotice(sessionId: string | null | undefined): boolean {
  return useInitialCommandHeldStore((s) => (sessionId ? s.bySession[sessionId] === "held" : false));
}

let subscribed: Promise<void> | null = null;

/** Subscribe to `initial-command-held` once for the app's lifetime (idempotent). */
export function ensureInitialCommandHeldSubscribed(): Promise<void> {
  if (!subscribed) {
    const failed = (err: unknown) => {
      subscribed = null;
      frontendLog("initial_command_held", `subscribe failed: ${errorMessage(err)}`);
    };
    try {
      subscribed = onInitialCommandHeld(recordInitialCommandHeld).then(() => undefined, failed);
    } catch (err) {
      // A non-Tauri environment can throw synchronously; never propagate.
      failed(err);
      return Promise.resolve();
    }
  }
  return subscribed;
}
