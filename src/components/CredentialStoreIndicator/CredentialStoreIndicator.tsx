import { useCallback } from "react";
import { KeyRound, Lock, LockOpen } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { lockCredentialStore } from "@/services/api";
import "./CredentialStoreIndicator.css";

/**
 * Status bar indicator showing the state of the credential store.
 *
 * For "master_password" mode it shows the lock state and toggles between
 * locked (opens the unlock dialog) and unlocked (locks the store) on click.
 * For "os_keychain" mode it shows a static, non-interactive "Keychain"
 * indicator (the OS manages access, so there is no in-app lock toggle).
 * It is hidden for "none" mode.
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

  if (!status) return null;

  if (status.mode === "os_keychain") {
    return (
      <span
        className="status-bar__item credential-indicator"
        title="Credentials are stored in the native OS credential store"
        data-testid="credential-store-indicator"
      >
        <KeyRound size={12} />
        Keychain
      </span>
    );
  }

  if (status.mode !== "master_password") return null;

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
