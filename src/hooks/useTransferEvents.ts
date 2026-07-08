import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { onTransferProgress } from "@/services/events";

/**
 * Hook that listens for `transfer-progress` events from the backend (#1245) and
 * folds them into the store's `transfers` map (#1247), driving the Open
 * Connections "Transfers" section, the file-browser footer, and the status-bar
 * aggregate.
 */
export function useTransferEvents(): void {
  const applyTransferProgress = useAppStore((s) => s.applyTransferProgress);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      unlisten = await onTransferProgress((progress) => {
        applyTransferProgress(progress);
      });
    };

    void setup();

    return () => {
      unlisten?.();
    };
  }, [applyTransferProgress]);
}
