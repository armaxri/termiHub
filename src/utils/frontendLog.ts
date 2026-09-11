import { invoke } from "@tauri-apps/api/core";

import { LogEntry } from "@/types/terminal";

type LogCallback = (entry: LogEntry) => void;

/**
 * Whether we are running inside the Tauri webview (as opposed to a browser test
 * environment). Guards the durable-log forward so `invoke` is never called where
 * the Tauri IPC does not exist.
 */
function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/**
 * Reentrancy guard: a failure while forwarding a log line must never itself emit
 * a frontend log that forwards again. The forward is best-effort and swallows all
 * errors, but this makes the no-loop guarantee explicit.
 */
let isForwarding = false;

/**
 * Forward an ERROR/WARN entry to the backend so it lands in the durable
 * `termihub.log` (OBS-001). Fire-and-forget and fully guarded: DEBUG/INFO stay
 * client-only, non-Tauri environments are skipped, and any failure is swallowed
 * so logging can never disrupt the UI or loop.
 */
function forwardToDurableLog(entry: LogEntry): void {
  if (entry.level !== "ERROR" && entry.level !== "WARN") return;
  if (isForwarding || !isTauriRuntime()) return;
  isForwarding = true;
  try {
    void invoke("record_frontend_log", {
      level: entry.level,
      target: entry.target.replace(/^frontend::/, ""),
      message: entry.message,
    }).catch(() => {
      /* best-effort durability: a backend logging failure must not surface */
    });
  } catch {
    /* invoke unavailable or threw synchronously — swallow */
  } finally {
    isForwarding = false;
  }
}

/**
 * Levels the frontend log channel can emit. These mirror the backend tracing
 * levels so the LogViewer's level filters (`ERROR`/`WARN`/`INFO`/`DEBUG`) apply
 * uniformly to frontend and backend entries.
 */
export type FrontendLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const listeners: LogCallback[] = [];

/**
 * Entries emitted before any listener has subscribed are held here so they
 * are not silently dropped during app startup (e.g. grammar registration
 * logs that fire before the LogViewer mounts).
 */
const startupBuffer: LogEntry[] = [];
const STARTUP_BUFFER_LIMIT = 500;

/** Subscribe to frontend log entries. Returns an unsubscribe function. */
export function onFrontendLog(cb: LogCallback): () => void {
  // Flush any entries that were buffered before this listener connected.
  if (startupBuffer.length > 0) {
    for (const entry of startupBuffer) {
      cb(entry);
    }
    startupBuffer.length = 0;
  }
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

/**
 * Emit a frontend log entry at the given level into the LogViewer.
 *
 * Entries are delivered to live listeners (the LogViewer) or, before any
 * listener has mounted, held in the bounded startup buffer.
 */
export function emitFrontendLog(level: FrontendLogLevel, target: string, message: string): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    target: `frontend::${target}`,
    message,
  };
  if (listeners.length === 0) {
    if (startupBuffer.length < STARTUP_BUFFER_LIMIT) {
      startupBuffer.push(entry);
    }
  } else {
    for (const cb of listeners) {
      cb(entry);
    }
  }
  // Durability path (OBS-001): mirror ERROR/WARN to the backend so they reach
  // `termihub.log`. Independent of the LogViewer listeners above.
  forwardToDurableLog(entry);
}

/** Emit a DEBUG log entry visible in the LogViewer. */
export function frontendLog(target: string, message: string): void {
  emitFrontendLog("DEBUG", target, message);
}

/** Emit an INFO log entry visible in the LogViewer. */
export function frontendInfo(target: string, message: string): void {
  emitFrontendLog("INFO", target, message);
}

/** Emit a WARN log entry visible in the LogViewer. */
export function frontendWarn(target: string, message: string): void {
  emitFrontendLog("WARN", target, message);
}

/**
 * Emit an ERROR log entry visible in the LogViewer.
 *
 * This is the sanctioned path for surfacing frontend failures — swallowed
 * catches, caught render crashes, and failed user actions — so they land in the
 * user-openable LogViewer instead of the DevTools console (which users cannot
 * reach). Prefer this over `console.error`.
 */
export function frontendError(target: string, message: string): void {
  emitFrontendLog("ERROR", target, message);
}

/**
 * Run a genuinely best-effort async operation without awaiting it, while keeping
 * its failure AUDITABLE. Attaches a `.catch` that logs any rejection to the
 * LogViewer — `WARN` by default, or `ERROR` for leak-risk teardown paths — tagged
 * with the caller-supplied `reason`, so a fire-and-forget cleanup / telemetry /
 * advisory call is never an untraceable `.catch(() => {})`.
 *
 * Use this ONLY when a failure does not change what the user believes happened
 * (best-effort cleanup, advisory signals, optional bookkeeping). If a failure
 * means a user-initiated action silently did not take effect, surface it with
 * `frontendError` (and usually a toast) instead — do not hide it here.
 *
 * The call is deliberately fire-and-forget: it returns `void`, so nothing awaits
 * it and a rejection can never surface as an unhandled promise rejection.
 *
 * @param promise the in-flight best-effort operation
 * @param reason  short phrase identifying the call site (e.g. "detach persistent tab on teardown")
 * @param level   log level for a rejection — `"warn"` (default) or `"error"`
 */
export function fireAndForget(
  promise: Promise<unknown>,
  reason: string,
  level: "warn" | "error" = "warn"
): void {
  void Promise.resolve(promise).catch((err: unknown) => {
    const log = level === "error" ? frontendError : frontendWarn;
    log("fire_and_forget", `${reason}: ${String(err)}`);
  });
}
