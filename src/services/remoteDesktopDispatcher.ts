/**
 * Routes the global remote-desktop Tauri events to per-session subscribers
 * (FEC2-002, #4378).
 *
 * Modeled on {@link TerminalOutputDispatcher}: one global listener per event
 * type for the whole window, routed through a `Map` keyed by session id. Before
 * this, every open remote-desktop tab registered its own `listen()` for state,
 * clipboard and certificate-prompt events and threw away every payload for a
 * different session, so the per-event cost grew with the number of tabs.
 *
 * Frames and cursor updates do not go through here: they arrive on a
 * per-session binary IPC channel (#4291, `remoteDesktopFrames.ts`), which the
 * backend already routes to the subscribing session only.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  onRemoteDesktopCertPrompt,
  onRemoteDesktopClipboard,
  onRemoteDesktopState,
} from "./events";
import type {
  RemoteDesktopCertPromptPayload,
  RemoteDesktopClipboardPayload,
  RemoteDesktopStatePayload,
} from "@/types/remoteDesktop";

type Callback<T> = (payload: T) => void;

/** Per-session callback sets for one event type. */
class SessionRoutes<T extends { session_id: string }> {
  private bySession = new Map<string, Set<Callback<T>>>();
  /** Callbacks that see every session's events (see {@link subscribeAll}). */
  private any = new Set<Callback<T>>();

  dispatch(payload: T): void {
    const cbs = this.bySession.get(payload.session_id);
    if (cbs) for (const cb of [...cbs]) cb(payload);
    for (const cb of [...this.any]) cb(payload);
  }

  add(sessionId: string, cb: Callback<T>): () => void {
    let cbs = this.bySession.get(sessionId);
    if (!cbs) {
      cbs = new Set();
      this.bySession.set(sessionId, cbs);
    }
    cbs.add(cb);
    return () => {
      const set = this.bySession.get(sessionId);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) this.bySession.delete(sessionId);
    };
  }

  addAny(cb: Callback<T>): () => void {
    this.any.add(cb);
    return () => {
      this.any.delete(cb);
    };
  }

  /** Number of registered callbacks (per-session plus any-session). */
  size(): number {
    let n = this.any.size;
    for (const set of this.bySession.values()) n += set.size;
    return n;
  }

  clear(): void {
    this.bySession.clear();
    this.any.clear();
  }
}

/**
 * Singleton-style dispatcher for remote-desktop lifecycle, clipboard and
 * certificate-prompt events. Listeners are registered lazily on the first
 * subscription and kept for the window's lifetime (one per event type).
 *
 * Every `subscribe…` registers its callback synchronously and resolves with an
 * unsubscribe fn once the global listener is live, so it plugs straight into
 * `subscribeGuarded` (the disposed guard) and a caller can fetch already-pending
 * state knowing no later event can be missed.
 */
export class RemoteDesktopDispatcher {
  private state = new SessionRoutes<RemoteDesktopStatePayload>();
  private clipboard = new SessionRoutes<RemoteDesktopClipboardPayload>();
  private certPrompt = new SessionRoutes<RemoteDesktopCertPromptPayload>();
  private unlisteners: UnlistenFn[] = [];
  private initPromise: Promise<void> | null = null;
  private initGeneration = 0;

  /**
   * Register the global listeners once. Concurrent callers share one promise.
   * A generation counter discards listeners that resolve after {@link destroy}
   * (StrictMode / test teardown), the same race guard as the terminal
   * dispatcher. A failed registration clears the promise so a later
   * subscription retries.
   */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err: unknown) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const gen = this.initGeneration;
    const registrations: Array<() => Promise<UnlistenFn>> = [
      () => onRemoteDesktopState((p) => this.state.dispatch(p)),
      () => onRemoteDesktopClipboard((p) => this.clipboard.dispatch(p)),
      () => onRemoteDesktopCertPrompt((p) => this.certPrompt.dispatch(p)),
    ];
    for (const register of registrations) {
      const unlisten = await register();
      if (gen !== this.initGeneration) {
        // destroy() ran while this registration was pending: it already tore
        // down the listeners tracked so far, so only this one is left.
        unlisten();
        return;
      }
      this.unlisteners.push(unlisten);
    }
  }

  /** Register `add`'s callback now; resolve with its remover once listening. */
  private async subscribe(add: () => () => void): Promise<UnlistenFn> {
    const remove = add();
    try {
      await this.init();
    } catch (err) {
      remove();
      throw err;
    }
    return remove;
  }

  /** Lifecycle state events for one session. */
  subscribeState(sessionId: string, cb: Callback<RemoteDesktopStatePayload>): Promise<UnlistenFn> {
    return this.subscribe(() => this.state.add(sessionId, cb));
  }

  /**
   * Lifecycle state events for every session. For a tab whose connect has not
   * returned its session id yet: the connect's own events arrive before the id
   * is known and must be buffered by the caller (#4017).
   */
  subscribeAllStates(cb: Callback<RemoteDesktopStatePayload>): Promise<UnlistenFn> {
    return this.subscribe(() => this.state.addAny(cb));
  }

  /** Remote → local clipboard text for one session. */
  subscribeClipboard(
    sessionId: string,
    cb: Callback<RemoteDesktopClipboardPayload>
  ): Promise<UnlistenFn> {
    return this.subscribe(() => this.clipboard.add(sessionId, cb));
  }

  /** Server-certificate trust prompts for one session (#1767). */
  subscribeCertPrompt(
    sessionId: string,
    cb: Callback<RemoteDesktopCertPromptPayload>
  ): Promise<UnlistenFn> {
    return this.subscribe(() => this.certPrompt.add(sessionId, cb));
  }

  /** Registered callbacks across all event types (diagnostics / tests). */
  subscriberCount(): number {
    return this.state.size() + this.clipboard.size() + this.certPrompt.size();
  }

  /** Tear down the global listeners and drop every subscriber. */
  destroy(): void {
    this.initGeneration++;
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    this.state.clear();
    this.clipboard.clear();
    this.certPrompt.clear();
    this.initPromise = null;
  }
}

/** The window's one remote-desktop event dispatcher. */
export const remoteDesktopDispatcher = new RemoteDesktopDispatcher();
