/**
 * Which sessions' transfer summaries are on screen right now (#5859).
 *
 * The file browser's {@link import("./TransferSummaryChip").TransferSummaryChip}
 * already reports "1 transfer done" for the session it browses. A "Downloaded
 * …" toast on top of that says the same thing a second time, so the toast hub
 * skips the success toast for a session whose summary is visible. Each mounted
 * chip counts once, so overlapping chips for one session (a remount) keep it
 * shown until the last one is gone.
 */
const shown = new Map<string, number>();

/** Mark `sessionId`'s transfer summary as on screen. Returns the undo. */
export function showTransferSummary(sessionId: string): () => void {
  shown.set(sessionId, (shown.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (shown.get(sessionId) ?? 1) - 1;
    if (left > 0) shown.set(sessionId, left);
    else shown.delete(sessionId);
  };
}

/** Whether a transfer summary for `sessionId` is on screen. */
export function isTransferSummaryShown(sessionId: string): boolean {
  return shown.has(sessionId);
}

/** Forget every shown summary (tests). */
export function resetTransferSummaries(): void {
  shown.clear();
}
