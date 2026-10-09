/**
 * Transfers whose terminal toast a batch summary owns (#4348, FEC2-004).
 *
 * A graphical-session upload (`uploadToRemoteDesktop`) shows one summary toast
 * for a whole drop ("Uploaded 30 files to …"). The global `transfer-progress`
 * handler (`useTransferEvents`) would otherwise also raise a per-file
 * "Uploaded <file>" / "Upload of <file> failed" toast for every one of them.
 * The batch registers its transfers here and the global handler stays quiet
 * for them.
 *
 * Two parts, because a small file can settle before the upload command
 * returns its transfer ids:
 * - a **pending** window per session, opened before the upload is queued and
 *   closed once the ids are known: uploads on that session settling in the
 *   window count as the batch's;
 * - the batch's **ids**, each released once its terminal phase was seen (or
 *   when the batch stops watching).
 */

/** Sessions with a batch upload being queued, refcounted. */
const pendingSessions = new Map<string, number>();
/** Transfer ids whose terminal toast a batch summary owns. */
const batchIds = new Set<string>();

/**
 * Open the pending window for `sessionId`. Call the returned function once
 * the batch's ids are known (or the upload was refused); it is idempotent.
 */
export function openBatchWindow(sessionId: string): () => void {
  pendingSessions.set(sessionId, (pendingSessions.get(sessionId) ?? 0) + 1);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const left = (pendingSessions.get(sessionId) ?? 1) - 1;
    if (left > 0) pendingSessions.set(sessionId, left);
    else pendingSessions.delete(sessionId);
  };
}

/** Mark `ids` as owned by a batch summary. */
export function claimBatchTransfers(ids: string[]): void {
  ids.forEach((id) => batchIds.add(id));
}

/** Forget `ids` (the batch stopped watching them). */
export function releaseBatchTransfers(ids: string[]): void {
  ids.forEach((id) => batchIds.delete(id));
}

/**
 * Whether a settled transfer's terminal toast belongs to a batch summary, so
 * the per-file toast must be skipped. A claimed id is released here: its
 * terminal phase is reported once.
 */
export function isBatchTransfer(progress: {
  transferId: string;
  sessionId: string;
  direction: string;
}): boolean {
  if (batchIds.delete(progress.transferId)) return true;
  return progress.direction === "upload" && pendingSessions.has(progress.sessionId);
}

/** Test-only: forget every registration. */
export function resetBatchTransfersForTest(): void {
  pendingSessions.clear();
  batchIds.clear();
}
