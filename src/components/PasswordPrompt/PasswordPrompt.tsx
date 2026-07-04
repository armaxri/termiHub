import { useState, useCallback, useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button } from "@/components/ui";
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
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v) dismissPasswordPrompt();
      }}
      title="SSH Password"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={dismissPasswordPrompt}
            data-testid="password-prompt-cancel"
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} data-testid="password-prompt-connect">
            Connect
          </Button>
        </>
      }
    >
      <p className="password-prompt__description">
        Enter password for {username}@{host}
      </p>
      <PasswordInput
        className="ui-input"
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
    </Modal>
  );
}
