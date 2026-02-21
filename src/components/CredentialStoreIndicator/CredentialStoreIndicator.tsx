import { useCallback } from "react";
import { Lock, LockOpen } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { lockCredentialStore } from "@/services/api";
import "./CredentialStoreIndicator.css";

/**
 * Status bar indicator showing the lock state of the credential store.
 * Only visible when the credential store mode is "master_password".
 * Clicking toggles between locked (opens unlock dialog) and unlocked (locks store).
 */
export function CredentialStoreIndicator() {
  const status = useAppStore((s) => s.credentialStoreStatus);
  const setUnlockDialogOpen = useAppStore((s) => s.setUnlockDialogOpen);

  const handleClick = useCallback(async () => {
    if (!status) return;
    if (status.status === "locked") {
      setUnlockDialogOpen(true);
    } else {
      try {
        await lockCredentialStore();
      } catch (err) {
        console.error("Failed to lock credential store:", err);
      }
    }
  }, [status, setUnlockDialogOpen]);

  if (!status || status.mode !== "master_password") return null;

  const isLocked = status.status === "locked";

  return (
    <button
      className="status-bar__item status-bar__item--interactive credential-indicator"
      onClick={handleClick}
      title={
        isLocked
          ? "Credential store is locked — click to unlock"
          : "Credential store is unlocked — click to lock"
      }
      data-testid="credential-store-indicator"
    >
      {isLocked ? <Lock size={12} /> : <LockOpen size={12} />}
      {isLocked ? "Locked" : "Unlocked"}
    </button>
  );
}
