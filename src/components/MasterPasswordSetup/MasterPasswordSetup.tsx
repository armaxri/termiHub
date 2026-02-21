import { useState, useCallback, useEffect, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { setupMasterPassword, changeMasterPassword } from "@/services/api";
import "./MasterPasswordSetup.css";

type PasswordStrength = "weak" | "medium" | "strong";

interface MasterPasswordSetupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "setup" | "change";
}

/**
 * Calculate password strength based on length and character diversity.
 * Exported for testing.
 */
export function calculatePasswordStrength(password: string): PasswordStrength {
  if (!password) return "weak";

  let typesCount = 0;
  if (/[a-z]/.test(password)) typesCount++;
  if (/[A-Z]/.test(password)) typesCount++;
  if (/[0-9]/.test(password)) typesCount++;
  if (/[^a-zA-Z0-9]/.test(password)) typesCount++;

  if (password.length >= 12 && typesCount >= 3) return "strong";
  if (password.length >= 8 && typesCount >= 2) return "medium";
  return "weak";
}

/**
 * Dialog for setting up or changing the master password.
 * Setup mode: new + confirm fields with warning about unrecoverable password.
 * Change mode: current + new + confirm fields.
 */
export function MasterPasswordSetup({ open, onOpenChange, mode }: MasterPasswordSetupProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setError("");
      setLoading(false);
    }
  }, [open]);

  const strength = useMemo(() => calculatePasswordStrength(newPassword), [newPassword]);

  const passwordsMatch = confirmPassword === "" || newPassword === confirmPassword;
  const isValid =
    newPassword.length >= 8 &&
    newPassword === confirmPassword &&
    (mode === "setup" || currentPassword.length > 0);

  const handleSubmit = useCallback(async () => {
    if (!isValid || loading) return;
    setLoading(true);
    setError("");
    try {
      if (mode === "setup") {
        await setupMasterPassword(newPassword);
      } else {
        await changeMasterPassword(currentPassword, newPassword);
      }
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save master password.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isValid, loading, mode, newPassword, currentPassword, onOpenChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && isValid) handleSubmit();
    },
    [isValid, handleSubmit]
  );

  const title = mode === "setup" ? "Set Master Password" : "Change Master Password";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="master-pw__overlay" />
        <Dialog.Content className="master-pw__content" onKeyDown={handleKeyDown}>
          <Dialog.Title className="master-pw__title">{title}</Dialog.Title>

          {mode === "setup" && (
            <p className="master-pw__warning" data-testid="master-pw-warning">
              This password cannot be recovered. If you forget it, your saved credentials will be
              lost.
            </p>
          )}

          {mode === "change" && (
            <div className="master-pw__field">
              <label className="master-pw__label" htmlFor="master-pw-current">
                Current Password
              </label>
              <input
                id="master-pw-current"
                className="master-pw__input"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Current password"
                autoFocus
                data-testid="master-pw-current"
              />
            </div>
          )}

          <div className="master-pw__field">
            <label className="master-pw__label" htmlFor="master-pw-new">
              {mode === "setup" ? "Password" : "New Password"}
            </label>
            <input
              id="master-pw-new"
              className="master-pw__input"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={mode === "setup" ? "Password (min 8 characters)" : "New password"}
              autoFocus={mode === "setup"}
              data-testid="master-pw-new"
            />
            {newPassword.length > 0 && (
              <div className="master-pw__strength" data-testid="master-pw-strength">
                <div className="master-pw__strength-bar">
                  <div
                    className={`master-pw__strength-segment master-pw__strength-segment--filled master-pw__strength-segment--${strength}`}
                  />
                  <div
                    className={`master-pw__strength-segment ${strength !== "weak" ? `master-pw__strength-segment--filled master-pw__strength-segment--${strength}` : ""}`}
                  />
                  <div
                    className={`master-pw__strength-segment ${strength === "strong" ? "master-pw__strength-segment--filled master-pw__strength-segment--strong" : ""}`}
                  />
                </div>
                <span className={`master-pw__strength-label master-pw__strength-label--${strength}`}>
                  {strength}
                </span>
              </div>
            )}
          </div>

          <div className="master-pw__field">
            <label className="master-pw__label" htmlFor="master-pw-confirm">
              Confirm Password
            </label>
            <input
              id="master-pw-confirm"
              className="master-pw__input"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm password"
              data-testid="master-pw-confirm"
            />
            {!passwordsMatch && (
              <p className="master-pw__mismatch" data-testid="master-pw-mismatch">
                Passwords do not match.
              </p>
            )}
          </div>

          {error && (
            <p className="master-pw__error" data-testid="master-pw-error">
              {error}
            </p>
          )}

          <div className="master-pw__actions">
            <button
              className="master-pw__btn master-pw__btn--secondary"
              onClick={() => onOpenChange(false)}
              data-testid="master-pw-cancel"
            >
              Cancel
            </button>
            <button
              className="master-pw__btn master-pw__btn--primary"
              onClick={handleSubmit}
              disabled={!isValid || loading}
              data-testid="master-pw-submit"
            >
              {loading ? "Saving..." : mode === "setup" ? "Set Password" : "Change Password"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
