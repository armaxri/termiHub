import { useState, useCallback, useEffect, useRef } from "react";
import { Fingerprint } from "lucide-react";
import {
  unlockCredentialStore,
  unlockCredentialStoreBiometric,
  resetCredentialStore,
  isBiometricUnlockError,
} from "@/services/api";
import { useOsAuthInfo } from "@/hooks/useOsAuthInfo";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, ConfirmDialog, Field, toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import "./UnlockDialog.css";
import { errorMessage } from "@/utils/errorMessage";
import { isImeComposing } from "@/utils/imeComposition";
import type { UnlockWaiter } from "@/store/slices/credentialStoreSlice";
import { unlockWaitingText } from "./unlockWaitingText";

import { ICON_SIZE } from "@/components/ui/iconSize";
interface UnlockDialogProps {
  open: boolean;
  /** Closing the dialog any other way than unlocking cancels the request. */
  onOpenChange: (open: boolean) => void;
  /**
   * Offer "Type password instead" (#5188, #5838) beside Cancel: a connect is
   * waiting that can go on by prompting for its secret, with the store left
   * locked.
   */
  connectFallback?: boolean;
  /** "Type password instead" was chosen (only with `connectFallback`). */
  onConnectWithoutSaved?: () => void;
  /**
   * The connects waiting on the unlock (#5684): the dialog names the first
   * and counts the rest. Empty or omitted for a plain (status-bar) unlock.
   */
  waiting?: readonly UnlockWaiter[];
}

/** Id of the unlock error line, referenced by the password field (#5629). */
const UNLOCK_ERROR_ID = "unlock-dialog-password-error";

const NO_WAITERS: readonly UnlockWaiter[] = [];

/**
 * The unlock dialog's "go on without the vault" action (#5838): short, and
 * secondary beside Cancel, so it never competes with Unlock.
 */
const TYPE_PASSWORD_INSTEAD_LABEL = "Type password instead";

/** Type guard for the backend's unlock error shape (see `UnlockCredentialStoreError`). */
function isCorruptStoreError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "corrupted" in err &&
    (err as { corrupted?: unknown }).corrupted === true
  );
}

/**
 * Dialog shown on app startup when the credential store is locked.
 * Prompts the user for their master password to unlock saved credentials.
 *
 * If the credentials file is corrupt (G8, #1144) the dialog surfaces a
 * "reset store" affordance instead of an endless "wrong password" loop.
 *
 * A user who simply *forgot* their master password is offered the same recovery
 * without needing the file to be corrupt (#1360): the always-present "Forgot
 * password?" affordance opens a destructive, clearly-worded confirm before
 * wiping the store, so a forgotten password is a guarded reset rather than a
 * dead-end.
 *
 * When biometric unlock is turned on (PROD-064) the dialog offers it first:
 * the Touch ID / Windows Hello prompt opens automatically once per opening,
 * and the master password field stays available as the fallback (cancelling
 * the OS prompt, or choosing "Use Master Password" in it, lands there).
 *
 * A connect waiting on the dialog is named in it (#5684) — "Unlock to connect
 * to prod-db (SSH) with its saved password." — so the dialog says why it is up.
 *
 * A connect waiting on the dialog can go on without the vault (#5188):
 * "Type password instead" (#5838) leaves the store locked and lets that
 * connect ask for its password. Cancel (always shown, #5838), Escape and ×
 * cancel the connect instead. The guarded "Forgot master password?" link sits
 * under the actions, away from the error line, so it is never the next thing
 * after a wrong password; its own confirm says it deletes every saved password.
 */
export function UnlockDialog({
  open,
  onOpenChange,
  connectFallback = false,
  onConnectWithoutSaved,
  waiting = NO_WAITERS,
}: UnlockDialogProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [corrupt, setCorrupt] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [biometricPending, setBiometricPending] = useState(false);
  const autoAttempted = useRef(false);
  const { info: osAuth, refresh: refreshOsAuth } = useOsAuthInfo();
  const biometric = osAuth?.biometricUnlock;
  const biometricAvailable = Boolean(biometric?.supported && biometric.enabled);
  const biometricLabel = biometric?.methodLabel ?? "biometrics";
  const waitingText = unlockWaitingText(waiting);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPassword("");
      setError("");
      setCorrupt(false);
      setLoading(false);
      setResetting(false);
      setConfirmReset(false);
      setBiometricPending(false);
    }
    autoAttempted.current = false;
  }, [open]);

  const handleBiometricUnlock = useCallback(async () => {
    if (biometricPending) return;
    setBiometricPending(true);
    setError("");
    try {
      await unlockCredentialStoreBiometric();
      onOpenChange(false);
    } catch (err) {
      if (isBiometricUnlockError(err)) {
        if (err.kind === "cancelled") {
          // The user chose the master password (or dismissed the prompt).
          setError("");
        } else if (err.kind === "storeCorrupted") {
          setCorrupt(true);
          setError(err.message);
        } else {
          frontendLog("credential", `Biometric unlock failed (${err.kind})`);
          setError(err.message);
        }
        if (err.kind === "invalidated" || err.kind === "notEnabled") void refreshOsAuth();
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBiometricPending(false);
    }
  }, [biometricPending, onOpenChange, refreshOsAuth]);

  // Offer biometrics first: prompt automatically once per opening.
  useEffect(() => {
    if (open && biometricAvailable && !autoAttempted.current) {
      autoAttempted.current = true;
      void handleBiometricUnlock();
    }
  }, [open, biometricAvailable, handleBiometricUnlock]);

  /** Try the typed password. Resolves `true` once unlocked, `false` on any failure. */
  const attemptUnlock = useCallback(async (): Promise<boolean> => {
    if (!password || loading) return false;
    setLoading(true);
    setError("");
    try {
      await unlockCredentialStore(password);
      onOpenChange(false);
      return true;
    } catch (err) {
      if (isCorruptStoreError(err)) {
        frontendLog("credential", "Unlock failed: credentials file is corrupt");
        setCorrupt(true);
        setError(
          "The credential store is corrupted and cannot be unlocked. Reset it to start over — your saved credentials will be lost."
        );
      } else {
        setError("Incorrect master password.");
      }
      setPassword("");
      return false;
    } finally {
      setLoading(false);
    }
  }, [password, loading, onOpenChange]);

  /**
   * The Unlock button's async click. A failed attempt rejects, so the Button
   * returns to idle instead of flashing its green success state (#5629); the
   * inline field error is the feedback, so no toast either.
   */
  const handleUnlockClick = useCallback(async () => {
    if (!(await attemptUnlock())) throw new Error("unlock failed");
  }, [attemptUnlock]);

  const handleReset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    try {
      await resetCredentialStore();
      setConfirmReset(false);
      // toast-policy: explains-outcome — says what to do next after the reset
      toast.success("Credential store reset — set a new master password to start over");
      onOpenChange(false);
    } catch (err) {
      const message = errorMessage(err);
      frontendLog("credential", `Failed to reset credential store: ${message}`);
      toast.error(`Failed to reset credential store: ${message}`);
    } finally {
      setResetting(false);
    }
  }, [resetting, onOpenChange]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (e.key === "Enter") void attemptUnlock();
    },
    [attemptUnlock]
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dismissTransientToasts
      title="Unlock credential store"
      footer={
        <div className="unlock-dialog__footer" data-testid="unlock-dialog-footer">
          <div className="unlock-dialog__actions">
            {/* Always a Cancel (#5838): it stops the waiting connect, if any. */}
            <Button variant="secondary" onClick={handleCancel} data-testid="unlock-dialog-cancel">
              Cancel
            </Button>
            {connectFallback && onConnectWithoutSaved && (
              <Button
                variant="secondary"
                onClick={onConnectWithoutSaved}
                data-testid="unlock-dialog-connect-without-saved"
              >
                {TYPE_PASSWORD_INSTEAD_LABEL}
              </Button>
            )}
            {corrupt ? (
              <Button
                variant="danger"
                onClick={handleReset}
                disabled={resetting}
                data-testid="unlock-dialog-reset"
              >
                {resetting ? "Resetting…" : "Reset store"}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={handleUnlockClick}
                errorToast={false}
                disabled={!password || loading}
                data-testid="unlock-dialog-unlock"
              >
                Unlock
              </Button>
            )}
          </div>
          {/* Tertiary, under the actions (#5188): never right below the error. */}
          {!corrupt && (
            <div className="unlock-dialog__forgot-row">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmReset(true)}
                data-testid="unlock-dialog-forgot"
              >
                Forgot master password?
              </Button>
            </div>
          )}
        </div>
      }
    >
      {/* One spacing container (#4710): the description, the optional biometric
          row, the password field and the error are separate blocks separated by the stack gap, so the input's focus ring never
          overlaps the wrapped description text above it. */}
      <div className="unlock-dialog__body" data-testid="unlock-dialog-body">
        <p className="unlock-dialog__description" data-testid="unlock-dialog-description">
          termiHub has saved credentials that are encrypted with your master password.
        </p>
        {waitingText && (
          <p className="unlock-dialog__waiting" data-testid="unlock-dialog-waiting">
            {waitingText}
          </p>
        )}
        {biometricAvailable && !corrupt && (
          <div className="unlock-dialog__biometric-row">
            <Button
              variant="secondary"
              icon={<Fingerprint size={ICON_SIZE.sm} />}
              onClick={() => void handleBiometricUnlock()}
              disabled={biometricPending}
              data-testid="unlock-dialog-biometric"
            >
              {biometricPending
                ? `Waiting for ${biometricLabel}…`
                : `Unlock with ${biometricLabel}`}
            </Button>
            <span className="unlock-dialog__biometric-or">or enter your master password</span>
          </div>
        )}
        <Field
          label="Master password"
          htmlFor="unlock-dialog-password"
          data-testid="unlock-dialog-field"
        >
          <PasswordInput
            id="unlock-dialog-password"
            className="ui-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus={!biometricAvailable}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? UNLOCK_ERROR_ID : undefined}
            data-testid="unlock-dialog-input"
          />
        </Field>
        {error && (
          <p
            className="unlock-dialog__error"
            id={UNLOCK_ERROR_ID}
            role="alert"
            data-testid="unlock-dialog-error"
          >
            {error}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirmReset}
        title="Reset credential store?"
        message={
          <p className="unlock-dialog__description">
            Resetting the credential store{" "}
            <strong>permanently deletes all saved passwords and passphrases</strong>. It cannot be
            undone. You&apos;ll set a new master password and type each password again the next time
            you connect.
          </p>
        }
        confirmLabel={resetting ? "Resetting…" : "Delete all saved passwords"}
        cancelLabel="Keep saved passwords"
        confirmVariant="danger"
        onConfirm={handleReset}
        onCancel={() => setConfirmReset(false)}
        data-testid="unlock-dialog-reset-confirm"
      />
    </Modal>
  );
}
