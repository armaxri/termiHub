import { LogEntry } from "@/types/terminal";

type LogCallback = (entry: LogEntry) => void;

const listeners: LogCallback[] = [];

/**
 * Entries emitted before any listener has subscribed are held here so they
 * are not silently dropped during app startup (e.g. grammar registration
 * logs that fire before the LogViewer mounts).
 */
const startupBuffer: LogEntry[] = [];
const STARTUP_BUFFER_LIMIT = 500;

/** Subscribe to frontend debug log entries. Returns an unsubscribe function. */
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

/** Emit a debug log entry visible in the LogViewer. */
export function frontendLog(target: string, message: string) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: "DEBUG",
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
