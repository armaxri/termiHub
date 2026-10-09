import { useEffect, useRef } from "react";
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
