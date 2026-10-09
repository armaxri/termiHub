import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { getRecoveryWarnings } from "@/services/storage";
import { frontendLog } from "@/utils/frontendLog";
import {
  onCredentialStoreLocked,
  onCredentialStoreUnlocked,
  onCredentialStoreStatusChanged,
  onCredentialStoreUnlockNeeded,
} from "@/services/events";
import { errorMessage } from "@/utils/errorMessage";
import { useTauriSubscription } from "./useTauriListener";

/**
 * Show warnings the backend produced after startup. Unlocking the store scopes
 * saved passwords per connection file (#3591), which may yield a one-time
 * notice about connections that shared a saved password.
 */
function showNewRecoveryWarnings(): void {
  getRecoveryWarnings()
    .then((warnings) => {
      if (warnings.length === 0) return;
      useAppStore.setState((s) => ({
        recoveryWarnings: [...s.recoveryWarnings, ...warnings],
        recoveryDialogOpen: true,
      }));
    })
    .catch((err: unknown) => {
      frontendLog("credential_store", `Failed to load recovery warnings: ${errorMessage(err)}`);
    });
}

/**
 * Hook that listens for credential store events from the backend
 * and updates the store accordingly.
 */
export function useCredentialStoreEvents(): void {
  const setCredentialStoreStatus = useAppStore((s) => s.setCredentialStoreStatus);
  const loadCredentialStoreStatus = useAppStore((s) => s.loadCredentialStoreStatus);
  const setUnlockDialogOpen = useAppStore((s) => s.setUnlockDialogOpen);
  const resolveUnlock = useAppStore((s) => s.resolveUnlock);

  // When the store locks, refresh status. Do NOT open the unlock dialog
  // proactively — only do so when credentials are actually needed (see the
  // unlock-needed handler below). On an inactivity auto-lock (auto=true),
  // show a low-key toast so the user knows why the next connect re-prompts
  // (G7, #1144). A manual lock (auto=false) is already confirmed by the
  // indicator, so it stays silent to avoid a double-toast.
  useTauriSubscription(
    onCredentialStoreLocked,
    (auto) => {
      loadCredentialStoreStatus();
      if (auto) {
        toast.success("Credential store auto-locked after inactivity");
      }
    },
    "credential_store"
  );

  useTauriSubscription(
    onCredentialStoreUnlocked,
    () => {
      // Resolve any pending requestUnlock() promise first, so callers that are
      // awaiting it can continue before the dialog closes.
      resolveUnlock(true);
      loadCredentialStoreStatus();
      setUnlockDialogOpen(false);
      showNewRecoveryWarnings();
    },
    "credential_store"
  );

  useTauriSubscription(
    onCredentialStoreStatusChanged,
    setCredentialStoreStatus,
    "credential_store"
  );

  // Open the unlock dialog only when a credential access is attempted
  // while the store is locked (demand-driven unlock).
  useTauriSubscription(
    onCredentialStoreUnlockNeeded,
    () => setUnlockDialogOpen(true),
    "credential_store"
  );
}
