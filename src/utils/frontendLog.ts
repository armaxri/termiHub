import { LogEntry } from "@/types/terminal";

type LogCallback = (entry: LogEntry) => void;

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
