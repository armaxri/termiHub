import { LogEntry } from "@/types/terminal";

type LogCallback = (entry: LogEntry) => void;

const listeners: LogCallback[] = [];

/** Subscribe to frontend debug log entries. Returns an unsubscribe function. */
export function onFrontendLog(cb: LogCallback): () => void {
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
  for (const cb of listeners) {
    cb(entry);
  }
}
