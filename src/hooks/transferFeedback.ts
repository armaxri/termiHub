import { TransferTerminalError } from "@/services/api";
import { toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import { dispatchTransferIntentBestEffort } from "@/store/transfersBridge";
import type { TransferDirection } from "@/types/transfer";

/**
 * Shared transfer-feedback helpers used by both the SFTP (`useFileSystem`) and
 * session (`useSessionFileSystem`) file-browser hooks. Extracted during the SFTP
 * convergence (#2421) so the two hooks drive an identical transfer contract —
 * the pending toast, the single-terminal-toast rule, and the Transfer-Queue seed
 * — over their respective dedicated-channel commands (`sftp_*` vs `session_*`).
 */

/** Basename of a POSIX/Windows path (the file name the queue row displays). */
export function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

/** Extract a human-readable message from an unknown transfer error. */
export function transferErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Seed a `queued` Transfer Queue row from the id a transfer start command
 * returns — the panel then opens without waiting for a `transfer-progress`
 * event, which can be dropped/delayed under memory pressure (#1632). The row is
 * keyed by the backend `transferId`, so a later event upserts (never duplicates)
 * it. Since #2229 the `transfers` region is authoritative, so the seed is a
 * reliable client `transfer.seed` intent against the shared store (idempotent
 * server-side — it never overwrites an already-advanced row); a bridge hiccup is
 * swallowed and logged.
 */
export function seedTransferQueueRow(seed: {
  transferId: string;
  sessionId: string;
  direction: TransferDirection;
  remotePath: string;
}): void {
  dispatchTransferIntentBestEffort("transfer.seed", {
    seed: {
      id: seed.transferId,
      sessionId: seed.sessionId,
      direction: seed.direction,
      name: baseName(seed.remotePath),
      path: seed.remotePath,
    },
  });
}

/**
 * Run a file transfer with user feedback: a pending toast shown while the
 * transfer runs (audit gap D2 — transfers must never fail silently).
 *
 * The **terminal** success/error toast is owned exclusively by the
 * `transfer-progress` event path (`useTransferEvents`, #1286) so a single
 * transfer produces exactly one terminal toast. This helper therefore does not
 * emit its own success/error toast for a transfer that reached the backend:
 *   - success → dismiss the pending toast (the event path raises the "Downloaded
 *     …/Uploaded …" success toast);
 *   - a {@link TransferTerminalError} (`done`/`cancelled`/`error` from the
 *     transfer channel) → dismiss the pending toast; the event path already
 *     surfaced the outcome (and stays quiet on cancel).
 *
 * An **early** failure that never produced a transfer event (invalid session,
 * permission error thrown before the transfer starts, a copy temp-file paste leg
 * that fails synchronously) is still surfaced here via `toast.error`, since no
 * `transfer-progress` event will cover it. The rejection is always swallowed so
 * callers never produce an unhandled rejection. Returns whether the transfer
 * succeeded.
 */
export async function runTransfer(
  label: string,
  action: () => Promise<unknown>,
  messages: { loading: string }
): Promise<boolean> {
  const toastId = toast.loading(messages.loading);
  try {
    await action();
    // Success toast is raised by the transfer-progress event path (#1286).
    toast.dismiss(toastId);
    return true;
  } catch (error) {
    if (error instanceof TransferTerminalError) {
      // The event path already surfaced this (success/error toast) or is
      // intentionally quiet (cancel) — just clear the pending toast.
      toast.dismiss(toastId);
      return false;
    }
    const message = transferErrorMessage(error);
    frontendLog("sftp_transfer", `${label} failed: ${message}`);
    toast.error(`${label} failed: ${message}`, { id: toastId });
    return false;
  }
}

/**
 * Open a native file picker (Save-as / Open) for a file-browser action, turning
 * a failure to open it into an error toast instead of a silent unhandled
 * rejection (#3458). Resolves to the picked path, or `null` when the user
 * cancelled or the picker failed.
 */
export async function pickPathOrReport(
  label: string,
  pick: () => Promise<string | string[] | null>
): Promise<string | null> {
  try {
    const picked = await pick();
    if (Array.isArray(picked)) return picked[0] ?? null;
    return picked;
  } catch (error) {
    const message = transferErrorMessage(error);
    frontendLog("file_transfer", `${label}: file picker failed: ${message}`);
    toast.error(`${label} failed: ${message}`);
    return null;
  }
}

/**
 * Run a **blocking** transfer that produces NO `transfer-progress` events — a
 * local Save-as copy or a byte-based (Docker / FTP / remote-agent)
 * download/upload round-trip — with self-contained feedback (audit UX-017:
 * "every action gives feedback").
 *
 * Unlike {@link runTransfer}, which defers the terminal *success* toast to the
 * event path (`useTransferEvents`), this helper owns the whole
 * `loading → success/error` lifecycle itself, because no `transfer-progress`
 * event will ever cover a blocking round-trip — so deferring would leave the
 * action silent on success. The single toast updates in place as the action
 * settles. The rejection is always swallowed so callers never produce an
 * unhandled rejection. Returns whether the transfer succeeded.
 */
export async function runBlockingTransfer(
  action: () => Promise<unknown>,
  messages: { loading: string; success: string; errorLabel: string }
): Promise<boolean> {
  const toastId = toast.loading(messages.loading);
  try {
    await action();
    toast.success(messages.success, { id: toastId });
    return true;
  } catch (error) {
    const message = transferErrorMessage(error);
    frontendLog("file_transfer", `${messages.errorLabel} failed: ${message}`);
    toast.error(`${messages.errorLabel} failed: ${message}`, { id: toastId });
    return false;
  }
}

/**
 * Run a transfer whose transport shape is only known once it runs — the paste
 * case, where a single leg may drive the dedicated SFTP channel *or* fall back
 * to a byte-based (Docker / FTP / remote-agent) round-trip depending on both
 * endpoints' capabilities. The `action` resolves to whether it drove the
 * **tracked** (event-emitting) channel:
 *   - `true`  → the `transfer-progress` event path owns the terminal success
 *     toast (`useTransferEvents`, #1286), so this helper only dismisses the
 *     pending toast — never a double toast on the SFTP path;
 *   - `false` → the byte-based leg emits no event and would otherwise complete
 *     silently (#2906), so this helper raises the success toast itself.
 *
 * Errors mirror {@link runTransfer}: a {@link TransferTerminalError} was already
 * surfaced (or intentionally suppressed on cancel) by the event path, so it only
 * dismisses the pending toast; any other error is surfaced here via `toast.error`.
 * The rejection is always swallowed so callers never produce an unhandled
 * rejection. Returns whether the transfer succeeded.
 */
export async function runMaybeTrackedTransfer(
  label: string,
  action: () => Promise<boolean>,
  messages: { loading: string; success: string }
): Promise<boolean> {
  const toastId = toast.loading(messages.loading);
  try {
    const tracked = await action();
    if (tracked) {
      // Dedicated channel: the transfer-progress event path raises the success
      // toast, so avoid a second one here.
      toast.dismiss(toastId);
    } else {
      // Byte-based round-trip: no event will cover it, so own the success toast.
      toast.success(messages.success, { id: toastId });
    }
    return true;
  } catch (error) {
    if (error instanceof TransferTerminalError) {
      // The event path already surfaced this (or is quiet on cancel).
      toast.dismiss(toastId);
      return false;
    }
    const message = transferErrorMessage(error);
    frontendLog("file_transfer", `${label} failed: ${message}`);
    toast.error(`${label} failed: ${message}`, { id: toastId });
    return false;
  }
}
