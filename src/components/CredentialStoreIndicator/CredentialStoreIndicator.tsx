import { useCallback } from "react";
import { KeyRound, Lock, LockOpen } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { lockCredentialStore } from "@/services/api";
import { toast } from "@/components/ui";
import "./CredentialStoreIndicator.css";
import { errorMessage } from "@/utils/errorMessage";
import { t } from "@/i18n/catalog";

/**
 * Status bar indicator showing the state of the credential store.
 *
 * For "master_password" mode it is a lock button (#5839): an icon and
 * "Locked"/"Unlocked" at normal contrast, outlined so it reads as a control;
 * a click opens the unlock dialog when locked and locks the store now when
 * unlocked. Toasts keep clear of the status bar (#5830), so none covers it.
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
        toast.error(`Failed to lock credential store: ${errorMessage(err)}`);
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
        {/* The key glyph means saved credentials; no connection type uses it (#5850). */}
        <KeyRound size={12} data-icon="key-round" />
        Keychain
      </span>
    );
  }

  if (status.mode !== "master_password") return null;

  const isLocked = status.status === "locked";
  // #5839: a real button at normal contrast whose accessible name says the
  // state and what a click does ("Locked, unlock the credential store").
  const actionLabel = isLocked ? t("statusBar.lock.unlock") : t("statusBar.lock.lockNow");

  return (
    <button
      type="button"
      className={`status-bar__item status-bar__item--interactive credential-indicator credential-indicator--button credential-indicator--${
        isLocked ? "locked" : "unlocked"
      }`}
      onClick={handleClick}
      aria-label={actionLabel}
      title={actionLabel}
      data-state={isLocked ? "locked" : "unlocked"}
      data-testid="credential-store-indicator"
    >
      {isLocked ? <Lock size={13} aria-hidden /> : <LockOpen size={13} aria-hidden />}
      {isLocked ? t("statusBar.lock.locked") : t("statusBar.lock.unlocked")}
    </button>
  );
}
