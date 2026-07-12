import { useState, useCallback, useEffect } from "react";
import { unlockCredentialStore, resetCredentialStore } from "@/services/api";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, ConfirmDialog, toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import "./UnlockDialog.css";

interface UnlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

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
 */
export function UnlockDialog({ open, onOpenChange }: UnlockDialogProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [corrupt, setCorrupt] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPassword("");
      setError("");
      setCorrupt(false);
      setLoading(false);
      setResetting(false);
      setConfirmReset(false);
    }
  }, [open]);

  const handleUnlock = useCallback(async () => {
    if (!password || loading) return;
    setLoading(true);
    setError("");
    try {
      await unlockCredentialStore(password);
      toast.success("Credential store unlocked");
      onOpenChange(false);
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
    } finally {
      setLoading(false);
    }
  }, [password, loading, onOpenChange]);

  const handleReset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    try {
      await resetCredentialStore();
      setConfirmReset(false);
      toast.success("Credential store reset — set a new master password to start over");
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      frontendLog("credential", `Failed to reset credential store: ${message}`);
      toast.error(`Failed to reset credential store: ${message}`);
    } finally {
      setResetting(false);
    }
  }, [resetting, onOpenChange]);

  const handleSkip = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleUnlock();
    },
    [handleUnlock]
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Unlock Credential Store"
      footer={
        <>
          <Button variant="secondary" onClick={handleSkip} data-testid="unlock-dialog-skip">
            Skip
          </Button>
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
              onClick={handleUnlock}
              disabled={!password || loading}
              data-testid="unlock-dialog-unlock"
            >
              Unlock
            </Button>
          )}
        </>
      }
    >
      <p className="unlock-dialog__description">
        termiHub has saved credentials that are encrypted with your master password.
      </p>
      <PasswordInput
        className="ui-input"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Master password"
        autoFocus
        data-testid="unlock-dialog-input"
      />
      {error && (
        <p className="unlock-dialog__error" data-testid="unlock-dialog-error">
          {error}
        </p>
      )}
      {!corrupt && (
        <div className="unlock-dialog__forgot-row">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmReset(true)}
            data-testid="unlock-dialog-forgot"
          >
            Forgot password? Reset credential store…
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmReset}
        title="Reset credential store?"
        message={
          <p className="unlock-dialog__description">
            This <strong>permanently deletes all saved credentials</strong> and cannot be undone.
            You&apos;ll set a new master password and re-enter your credentials from scratch.
          </p>
        }
        confirmLabel={resetting ? "Resetting…" : "Delete all credentials"}
        cancelLabel="Keep credentials"
        confirmVariant="danger"
        onConfirm={handleReset}
        onCancel={() => setConfirmReset(false)}
        data-testid="unlock-dialog-reset-confirm"
      />
    </Modal>
  );
}
