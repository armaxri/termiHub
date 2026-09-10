import { frontendError } from "@/utils/frontendLog";

/**
 * Render an arbitrary thrown/rejected value as a readable single string,
 * preferring an Error's stack so the LogViewer entry is diagnosable.
 */
function describeError(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ? `${value.message}\n${value.stack}` : value.message;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Uninstall handle for the process-wide install (idempotency guard). */
let windowUninstall: (() => void) | null = null;

/**
 * Install global `unhandledrejection` and `error` listeners that route
 * otherwise-invisible failures into the frontend ERROR channel (the LogViewer).
 *
 * Un-awaited `invoke` rejections and uncaught exceptions would otherwise vanish
 * into the DevTools console — which users and field supporters cannot open — so
 * this is the catch-all that makes the whole fire-and-forget failure class
 * observable. Wire it once during app bootstrap, before React mounts.
 *
 * Returns an uninstall function. Installing twice on the same `window` is a
 * no-op that returns the original uninstall handle.
 *
 * @param target Event target to attach to (defaults to `window`; overridable in tests).
 */
export function installGlobalErrorHandlers(
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window
): () => void {
  const isWindow = typeof window !== "undefined" && target === window;
  if (isWindow && windowUninstall) return windowUninstall;

  const onRejection = (event: PromiseRejectionEvent): void => {
    frontendError("unhandled", `unhandled promise rejection: ${describeError(event.reason)}`);
  };

  const onError = (event: ErrorEvent): void => {
    const where = event.filename
      ? ` (${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0})`
      : "";
    frontendError(
      "unhandled",
      `uncaught error${where}: ${describeError(event.error ?? event.message)}`
    );
  };

  target.addEventListener("unhandledrejection", onRejection as EventListener);
  target.addEventListener("error", onError as EventListener);

  const dispose = (): void => {
    target.removeEventListener("unhandledrejection", onRejection as EventListener);
    target.removeEventListener("error", onError as EventListener);
    if (isWindow) windowUninstall = null;
  };

  if (isWindow) windowUninstall = dispose;
  return dispose;
}
