import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import {
  onCredentialStoreLocked,
  onCredentialStoreUnlocked,
  onCredentialStoreStatusChanged,
  onCredentialStoreUnlockNeeded,
} from "@/services/events";

/**
 * Hook that listens for credential store events from the backend
 * and updates the store accordingly.
 */
export function useCredentialStoreEvents(): void {
  const setCredentialStoreStatus = useAppStore((s) => s.setCredentialStoreStatus);
  const loadCredentialStoreStatus = useAppStore((s) => s.loadCredentialStoreStatus);
  const setUnlockDialogOpen = useAppStore((s) => s.setUnlockDialogOpen);
  const resolveUnlock = useAppStore((s) => s.resolveUnlock);

  useEffect(() => {
    let unlistenLocked: (() => void) | null = null;
    let unlistenUnlocked: (() => void) | null = null;
    let unlistenStatusChanged: (() => void) | null = null;
    let unlistenUnlockNeeded: (() => void) | null = null;

    const setup = async () => {
      // When the store locks, refresh status. Do NOT open the unlock dialog
      // proactively — only do so when credentials are actually needed (see the
      // unlock-needed handler below). On an inactivity auto-lock (auto=true),
      // show a low-key toast so the user knows why the next connect re-prompts
      // (G7, #1144). A manual lock (auto=false) is already confirmed by the
      // indicator, so it stays silent to avoid a double-toast.
      unlistenLocked = await onCredentialStoreLocked((auto) => {
        loadCredentialStoreStatus();
        if (auto) {
          toast.success("Credential store auto-locked after inactivity");
        }
      });

      unlistenUnlocked = await onCredentialStoreUnlocked(() => {
        // Resolve any pending requestUnlock() promise first, so callers that are
        // awaiting it can continue before the dialog closes.
        resolveUnlock(true);
        loadCredentialStoreStatus();
        setUnlockDialogOpen(false);
      });

      unlistenStatusChanged = await onCredentialStoreStatusChanged((status) => {
        setCredentialStoreStatus(status);
      });

      // Open the unlock dialog only when a credential access is attempted
      // while the store is locked (demand-driven unlock).
      unlistenUnlockNeeded = await onCredentialStoreUnlockNeeded(() => {
        setUnlockDialogOpen(true);
      });
    };

    setup();

    return () => {
      unlistenLocked?.();
      unlistenUnlocked?.();
      unlistenStatusChanged?.();
      unlistenUnlockNeeded?.();
    };
  }, [setCredentialStoreStatus, loadCredentialStoreStatus, setUnlockDialogOpen, resolveUnlock]);
}
