import { useState, useCallback, useEffect } from "react";
import { unlockCredentialStore } from "@/services/api";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, toast } from "@/components/ui";
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
      toast.success("Credential store unlocked");
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Unlock Credential Store"
      footer={
        <>
          <Button variant="secondary" onClick={handleSkip} data-testid="unlock-dialog-skip">
            Skip
          </Button>
          <Button
            variant="primary"
            onClick={handleUnlock}
            disabled={!password || loading}
            data-testid="unlock-dialog-unlock"
          >
            Unlock
          </Button>
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
    </Modal>
  );
}
