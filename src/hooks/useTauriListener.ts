import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Register an async Tauri listener with the disposed guard (FEC-017, FEC2-005).
 *
 * `register` resolves to the listener's unlisten fn some time after it is
 * called. The returned dispose fn may run before that happens (React
 * StrictMode's mount → unmount → mount, or a fast phase change); the guard then
 * unlistens as soon as registration resolves, so the late listener never leaks.
 * A failed registration is logged under `scope` rather than surfacing as an
 * unhandled rejection.
 */
export function subscribeGuarded(
  register: () => Promise<UnlistenFn>,
  scope: string,
  what: string
): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  let pending: Promise<UnlistenFn>;
  try {
    pending = register();
  } catch (err) {
    // A registration that throws synchronously is reported like a rejection.
    pending = Promise.reject(err);
  }
  pending
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((err: unknown) => {
      frontendLog(scope, `Failed to subscribe to ${what}: ${errorMessage(err)}`);
    });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

/**
 * Subscribe through one of the typed `on…` wrappers in `@/services/events` for
 * the component's lifetime, with the disposed guard of {@link subscribeGuarded}.
 *
 * The latest `handler` is always called (held in a ref), so a handler that
 * closes over props or state does not re-subscribe on every render. Events that
 * arrive after unmount are dropped.
 */
export function useTauriSubscription<T extends unknown[]>(
  subscribe: (callback: (...args: T) => void) => Promise<UnlistenFn>,
  handler: (...args: T) => void,
  scope: string
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let active = true;
    const dispose = subscribeGuarded(
      () =>
        subscribe((...args: T) => {
          if (active) handlerRef.current(...args);
        }),
      scope,
      "backend events"
    );
    return () => {
      active = false;
      dispose();
    };
  }, [subscribe, scope]);
}

/**
 * Listen to the raw Tauri event `event` for the component's lifetime, with the
 * disposed guard of {@link subscribeGuarded}. `handler` receives the event
 * payload; the latest handler is always called without re-subscribing.
 */
export function useTauriListener<T>(
  event: string,
  handler: (payload: T) => void,
  scope = "tauri_listener"
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let active = true;
    const dispose = subscribeGuarded(
      () =>
        listen<T>(event, (e) => {
          if (active) handlerRef.current(e.payload);
        }),
      scope,
      `"${event}"`
    );
    return () => {
      active = false;
      dispose();
    };
  }, [event, scope]);
}

/**
 * A set of listeners registered imperatively (from a click handler rather than
 * an effect) that must not outlive the component (#4576).
 */
export interface ListenerGroup {
  /**
   * Register a listener into the group. Resolves `true` when the listener is
   * now held by the group, or `false` when the group was released or the
   * component unmounted while registration was pending; the late listener has
   * then already been unlistened, and the caller should abandon its run.
   * A registration error propagates to the caller.
   */
  attach(register: () => Promise<UnlistenFn>): Promise<boolean>;
  /** Unlisten every held listener and invalidate every pending registration. */
  release(): void;
  /** Whether the owning component has unmounted. */
  isDisposed(): boolean;
}

/**
 * A {@link ListenerGroup} tied to the component's lifetime: unmount releases
 * it, and a registration that resolves after unmount is unlistened at once —
 * the imperative counterpart of {@link subscribeGuarded}'s disposed guard.
 */
export function useListenerGroup(): ListenerGroup {
  const [group] = useState(() => {
    let disposed = false;
    let generation = 0;
    const held = new Set<UnlistenFn>();
    const release = () => {
      generation += 1;
      const fns = [...held];
      held.clear();
      for (const fn of fns) fn();
    };
    return {
      api: {
        async attach(register: () => Promise<UnlistenFn>) {
          const gen = generation;
          const fn = await register();
          if (disposed || gen !== generation) {
            fn();
            return false;
          }
          held.add(fn);
          return true;
        },
        release,
        isDisposed: () => disposed,
      } satisfies ListenerGroup,
      mount() {
        disposed = false;
      },
      dispose() {
        disposed = true;
        release();
      },
    };
  });

  useEffect(() => {
    group.mount();
    return group.dispose;
  }, [group]);

  return group.api;
}
