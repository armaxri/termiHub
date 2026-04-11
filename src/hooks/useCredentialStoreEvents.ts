import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
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

  useEffect(() => {
    let unlistenLocked: (() => void) | null = null;
    let unlistenUnlocked: (() => void) | null = null;
    let unlistenStatusChanged: (() => void) | null = null;
    let unlistenUnlockNeeded: (() => void) | null = null;

    const setup = async () => {
      // When the store locks (e.g. auto-lock timer), just refresh status silently.
      // Do NOT open the unlock dialog proactively — only do so when credentials
      // are actually needed (see unlock-needed handler below).
      unlistenLocked = await onCredentialStoreLocked(() => {
        loadCredentialStoreStatus();
      });

      unlistenUnlocked = await onCredentialStoreUnlocked(() => {
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
  }, [setCredentialStoreStatus, loadCredentialStoreStatus, setUnlockDialogOpen]);
}
