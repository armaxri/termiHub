import { useCallback, useMemo } from "react";

import { toast } from "@/components/ui";
import { transferCancel, transferPause, transferResume, transferRetry } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";

/**
 * The transfer-control action handlers shared by every surface that offers
 * per-transfer controls — the docked {@link import("@/components/TransferQueue").TransferQueue}
 * panel and the file-browser footer (UX-020: one control language, not two).
 *
 * Each handler drives a backend transfer command and gives honest feedback
 * (audit FEC-004 / UX-016): the command resolves `true` only when the transfer
 * really changed state, so a `false` resolution is a silent backend no-op — an
 * unknown/finished id, or a legacy SFTP transfer whose pause/resume/retry the
 * queue does not implement — and must surface an *info* toast, never a success.
 * A rejection surfaces an error toast rather than failing silently.
 */
export interface TransferControlHandlers {
  /** Pause an active transfer. */
  handlePause: (id: string) => Promise<void>;
  /** Resume a paused transfer. */
  handleResume: (id: string) => Promise<void>;
  /** Cancel a queued/active/paused transfer. */
  handleCancel: (id: string) => Promise<void>;
  /** Retry a failed/cancelled transfer. */
  handleRetry: (id: string) => Promise<void>;
}

/**
 * Build the shared {@link TransferControlHandlers}. Extracted from the Transfer
 * Queue panel so the file-browser footer drives the identical control contract
 * (same commands, same success/no-op/error toasts) instead of a divergent set
 * (UX-020).
 */
export function useTransferControls(): TransferControlHandlers {
  const runControl = useCallback(
    async (
      action: () => Promise<boolean>,
      messages: { success: string; noop: string; error: string }
    ) => {
      try {
        const changed = await action();
        if (changed) {
          toast.success(messages.success);
        } else {
          toast.info(messages.noop);
        }
      } catch (err) {
        frontendLog("transfer_queue", `${messages.error}: ${String(err)}`);
        toast.error(messages.error);
      }
    },
    []
  );

  return useMemo(
    () => ({
      handlePause: (id: string) =>
        runControl(() => transferPause(id), {
          success: "Transfer paused",
          noop: "Pause isn't available for this transfer",
          error: "Failed to pause transfer",
        }),
      handleResume: (id: string) =>
        runControl(() => transferResume(id), {
          success: "Transfer resumed",
          noop: "Resume isn't available for this transfer",
          error: "Failed to resume transfer",
        }),
      handleCancel: (id: string) =>
        runControl(() => transferCancel(id), {
          success: "Transfer cancelled",
          noop: "Transfer already finished",
          error: "Failed to cancel transfer",
        }),
      handleRetry: (id: string) =>
        runControl(() => transferRetry(id), {
          success: "Retrying transfer",
          noop: "Retry isn't available for this transfer",
          error: "Failed to retry transfer",
        }),
    }),
    [runControl]
  );
}
