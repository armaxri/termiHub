import { useState, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { unlockCredentialStore } from "@/services/api";
import "./UnlockDialog.css";

interface UnlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog shown on app startup when the credential store is locked.
 * Prompts the user for their master password to unlock saved credentials.
 */
export function UnlockDialog({ open, onOpenChange }: UnlockDialogProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPassword("");
      setError("");
      setLoading(false);
    }
  }, [open]);

  const handleUnlock = useCallback(async () => {
    if (!password || loading) return;
    setLoading(true);
    setError("");
    try {
      await unlockCredentialStore(password);
      onOpenChange(false);
    } catch {
      setError("Incorrect master password.");
      setPassword("");
    } finally {
      setLoading(false);
    }
  }, [password, loading, onOpenChange]);

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="unlock-dialog__overlay" />
        <Dialog.Content className="unlock-dialog__content">
          <Dialog.Title className="unlock-dialog__title">Unlock Credential Store</Dialog.Title>
          <Dialog.Description className="unlock-dialog__description">
            termiHub has saved credentials that are encrypted with your master password.
          </Dialog.Description>
          <input
            className="unlock-dialog__input"
            type="password"
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
          <div className="unlock-dialog__actions">
            <button
              className="unlock-dialog__btn unlock-dialog__btn--secondary"
              onClick={handleSkip}
              data-testid="unlock-dialog-skip"
            >
              Skip
            </button>
            <button
              className="unlock-dialog__btn unlock-dialog__btn--primary"
              onClick={handleUnlock}
              disabled={!password || loading}
              data-testid="unlock-dialog-unlock"
            >
              {loading ? "Unlocking..." : "Unlock"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
