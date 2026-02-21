import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import {
  onCredentialStoreLocked,
  onCredentialStoreUnlocked,
  onCredentialStoreStatusChanged,
} from "@/services/events";

/**
 * Hook that listens for credential store events from the backend
 * and updates the store accordingly.
 */
export function useCredentialStoreEvents(): void {
  const setCredentialStoreStatus = useAppStore((s) => s.setCredentialStoreStatus);
  const loadCredentialStoreStatus = useAppStore((s) => s.loadCredentialStoreStatus);

  useEffect(() => {
    let unlistenLocked: (() => void) | null = null;
    let unlistenUnlocked: (() => void) | null = null;
    let unlistenStatusChanged: (() => void) | null = null;

    const setup = async () => {
      unlistenLocked = await onCredentialStoreLocked(() => {
        loadCredentialStoreStatus();
      });

      unlistenUnlocked = await onCredentialStoreUnlocked(() => {
        loadCredentialStoreStatus();
      });

      unlistenStatusChanged = await onCredentialStoreStatusChanged((status) => {
        setCredentialStoreStatus(status);
      });
    };

    setup();

    return () => {
      unlistenLocked?.();
      unlistenUnlocked?.();
      unlistenStatusChanged?.();
    };
  }, [setCredentialStoreStatus, loadCredentialStoreStatus]);
}
