import { useState, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "@/store/appStore";
import "./PasswordPrompt.css";

/**
 * Global dialog that prompts the user for an SSH password at connect time.
 */
export function PasswordPrompt() {
  const open = useAppStore((s) => s.passwordPromptOpen);
  const host = useAppStore((s) => s.passwordPromptHost);
  const username = useAppStore((s) => s.passwordPromptUsername);
  const submitPassword = useAppStore((s) => s.submitPassword);
  const dismissPasswordPrompt = useAppStore((s) => s.dismissPasswordPrompt);

  const [password, setPassword] = useState("");

  // Reset field when the dialog opens
  useEffect(() => {
    if (open) setPassword("");
  }, [open]);

  const handleSubmit = useCallback(() => {
    submitPassword(password);
  }, [password, submitPassword]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit]
  );

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) dismissPasswordPrompt(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="password-prompt__overlay" />
        <Dialog.Content className="password-prompt__content">
          <Dialog.Title className="password-prompt__title">SSH Password</Dialog.Title>
          <Dialog.Description className="password-prompt__description">
            Enter password for {username}@{host}
          </Dialog.Description>
          <input
            className="password-prompt__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Password"
            autoFocus
          />
          <div className="password-prompt__actions">
            <button
              className="password-prompt__btn password-prompt__btn--secondary"
              onClick={dismissPasswordPrompt}
            >
              Cancel
            </button>
            <button
              className="password-prompt__btn password-prompt__btn--primary"
              onClick={handleSubmit}
            >
              Connect
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
