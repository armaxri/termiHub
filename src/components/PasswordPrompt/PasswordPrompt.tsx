import { useState, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "@/store/appStore";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import "./PasswordPrompt.css";

/**
 * Global dialog that prompts the user for an SSH password at connect time.
 *
 * When a credential store is configured (any mode other than "none"), a
 * "Save password" checkbox is shown so the user can persist the credential
 * for future connections without having to re-enter it.
 */
export function PasswordPrompt() {
  const open = useAppStore((s) => s.passwordPromptOpen);
  const host = useAppStore((s) => s.passwordPromptHost);
  const username = useAppStore((s) => s.passwordPromptUsername);
  const submitPassword = useAppStore((s) => s.submitPassword);
  const dismissPasswordPrompt = useAppStore((s) => s.dismissPasswordPrompt);
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);

  const storeActive = credentialStoreStatus != null && credentialStoreStatus.mode !== "none";

  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(false);

  // Reset fields when the dialog opens; default "save" to on when a store is active
  useEffect(() => {
    if (open) {
      setPassword("");
      setSavePassword(storeActive);
    }
  }, [open, storeActive]);

  const handleSubmit = useCallback(() => {
    submitPassword(password, savePassword);
  }, [password, savePassword, submitPassword]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit]
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) dismissPasswordPrompt();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="password-prompt__overlay" />
        <Dialog.Content className="password-prompt__content">
          <Dialog.Title className="password-prompt__title">SSH Password</Dialog.Title>
          <Dialog.Description className="password-prompt__description">
            Enter password for {username}@{host}
          </Dialog.Description>
          <PasswordInput
            className="password-prompt__input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Password"
            autoFocus
            data-testid="password-prompt-input"
          />
          {storeActive && (
            <label className="password-prompt__save-label" data-testid="password-prompt-save-label">
              <input
                type="checkbox"
                checked={savePassword}
                onChange={(e) => setSavePassword(e.target.checked)}
                data-testid="password-prompt-save-checkbox"
              />
              Save password
            </label>
          )}
          <div className="password-prompt__actions">
            <button
              className="password-prompt__btn password-prompt__btn--secondary"
              onClick={dismissPasswordPrompt}
              data-testid="password-prompt-cancel"
            >
              Cancel
            </button>
            <button
              className="password-prompt__btn password-prompt__btn--primary"
              onClick={handleSubmit}
              data-testid="password-prompt-connect"
            >
              Connect
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
