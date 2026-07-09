import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { onTransferProgress } from "@/services/events";
import { toast } from "@/components/ui";
import type { TransferProgress } from "@/services/api";

/**
 * Raise the single terminal-phase toast for a settled transfer (#1286).
 *
 * This event path is the **sole owner** of the terminal success/error toast, so
 * a transfer — however it was initiated (file-browser download/upload/paste, or
 * a background transfer that never went through `runTransfer`) — produces
 * exactly one terminal toast. The file-browser `runTransfer` helper only shows a
 * pending toast and dismisses it, deferring the terminal toast here (see
 * `useFileSystem.ts`).
 *
 * - `done`      → `toast.success` ("Downloaded …" / "Uploaded …").
 * - `error`     → recoverable `toast.error` carrying the backend `message`.
 * - `cancelled` → stay quiet: the user initiated the cancel, and the Cancel
 *   button already raises its own "Transfer cancelled" confirmation
 *   (`FileBrowser`/`OpenConnectionsModal`), so toasting the `cancelled` phase
 *   here would double up. The in-flight row simply disappears from the
 *   Transfers UI.
 */
function toastTerminalPhase(progress: TransferProgress): void {
  const { phase, direction, fileName, message } = progress;
  if (phase === "done") {
    const verb = direction === "download" ? "Downloaded" : "Uploaded";
    toast.success(`${verb} ${fileName}`);
  } else if (phase === "error") {
    const verb = direction === "download" ? "Download" : "Upload";
    toast.error(`${verb} of ${fileName} failed: ${message ?? "Transfer failed"}`);
  }
  // `cancelled` and `transferring` intentionally emit no toast.
}

/**
 * Hook that listens for `transfer-progress` events from the backend (#1245) and
 * folds them into the store's `transfers` map (#1247), driving the Open
 * Connections "Transfers" section, the file-browser footer, and the status-bar
 * aggregate. On a terminal phase it also raises the one success/error toast for
 * the transfer (#1286).
 */
export function useTransferEvents(): void {
  const applyTransferProgress = useAppStore((s) => s.applyTransferProgress);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      unlisten = await onTransferProgress((progress) => {
        applyTransferProgress(progress);
        toastTerminalPhase(progress);
      });
    };

    void setup();

    return () => {
      unlisten?.();
    };
  }, [applyTransferProgress]);
}
