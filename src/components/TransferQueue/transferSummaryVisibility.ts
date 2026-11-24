/**
 * Which sessions' transfer summaries are on screen right now (#5859).
 *
 * The file browser's {@link import("./TransferSummaryChip").TransferSummaryChip}
 * already reports "1 transfer done" for the session it browses. A "Downloaded
 * …" toast on top of that says the same thing a second time, so the toast hub
 * skips the success toast for a session whose summary is visible. Each mounted
 * chip counts once, so overlapping chips for one session (a remount) keep it
 * shown until the last one is gone.
 *
 * The status bar's transfer count reads it too (#5834): while every queued
 * transfer is already summarised in a file browser, the count would only repeat
 * that line, so it hides. {@link useTransferSummariesVersion} re-renders it when
 * a summary appears or goes away.
 */
import { useSyncExternalStore } from "react";

const shown = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

/** Mark `sessionId`'s transfer summary as on screen. Returns the undo. */
export function showTransferSummary(sessionId: string): () => void {
  const wasShown = shown.has(sessionId);
  shown.set(sessionId, (shown.get(sessionId) ?? 0) + 1);
  if (!wasShown) changed();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (shown.get(sessionId) ?? 1) - 1;
    if (left > 0) {
      shown.set(sessionId, left);
    } else {
      shown.delete(sessionId);
      changed();
    }
  };
}

/** Whether a transfer summary for `sessionId` is on screen. */
export function isTransferSummaryShown(sessionId: string): boolean {
  return shown.has(sessionId);
}

/**
 * Subscribe a component to summaries appearing and going away. Returns a number
 * that changes on each such change; read {@link isTransferSummaryShown} after it.
 */
export function useTransferSummariesVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version
  );
}

/** Forget every shown summary (tests). */
export function resetTransferSummaries(): void {
  shown.clear();
  changed();
}
