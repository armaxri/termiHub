import { useState, useCallback, useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, Checkbox } from "@/components/ui";
import "./PasswordPrompt.css";
import { isImeComposing } from "@/utils/imeComposition";

/**
 * Global dialog that prompts the user for an SSH password at connect time.
 *
 * When a credential store is configured (any mode other than "none"), a
 * "Save password" checkbox is shown so the user can persist the credential
 * for future connections without having to re-enter it. A caller that never
 * persists the secret (Test Connection, #3316) opts out via
 * `requestPassword(..., { allowSave: false })`, which hides the checkbox.
 *
 * Concurrent requests queue (#4312): the dialog shows the oldest one, titled
 * with the connection it is for, says how many more are waiting, and resets its
 * fields when it advances to the next request.
 */
export function PasswordPrompt() {
  const open = useAppStore((s) => s.passwordPromptOpen);
  const host = useAppStore((s) => s.passwordPromptHost);
  const username = useAppStore((s) => s.passwordPromptUsername);
  const notice = useAppStore((s) => s.passwordPromptNotice);
  const kind = useAppStore((s) => s.passwordPromptKind);
  const submitPassword = useAppStore((s) => s.submitPassword);
  const dismissPasswordPrompt = useAppStore((s) => s.dismissPasswordPrompt);
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);

  const allowSave = useAppStore((s) => s.passwordPromptAllowSave);
  const label = useAppStore((s) => s.passwordPromptLabel);
  const requestId = useAppStore((s) => s.passwordPromptQueue[0]?.id ?? null);
  const waiting = useAppStore((s) => Math.max(0, s.passwordPromptQueue.length - 1));

  const storeActive = credentialStoreStatus != null && credentialStoreStatus.mode !== "none";
  const showSave = storeActive && allowSave;

  // A key passphrase unlocks a private key file — it is not the remote account
  // password, so label the prompt accordingly (UX-010).
  const isPassphrase = kind === "key_passphrase";
  const baseTitle = isPassphrase ? "SSH Key Passphrase" : "SSH Password";
  const title = label ? `${baseTitle} — ${label}` : baseTitle;
  const waitingText = `${waiting} more password ${waiting === 1 ? "prompt" : "prompts"} waiting`;
  const description = isPassphrase
    ? `Enter the passphrase for the SSH key used by ${username}@${host}`
    : `Enter password for ${username}@${host}`;
  const inputPlaceholder = isPassphrase ? "Passphrase" : "Password";
  const inputAriaLabel = isPassphrase ? "SSH key passphrase" : "SSH password";
  const saveLabel = isPassphrase ? "Save passphrase" : "Save password";

  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(false);

  // Reset fields whenever a new request is shown (the dialog opening, or the
  // queue advancing to the next request, #4312); default "save" to on when a
  // store is active.
  useEffect(() => {
    if (requestId !== null) {
      setPassword("");
      setSavePassword(showSave);
    }
  }, [requestId, showSave]);

  const handleSubmit = useCallback(() => {
    submitPassword(password, showSave && savePassword);
  }, [password, showSave, savePassword, submitPassword]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isImeComposing(e)) return;
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
      title={title}
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
      {notice && (
        <p className="password-prompt__notice" role="alert" data-testid="password-prompt-notice">
          {notice}
        </p>
      )}
      <p className="password-prompt__description" data-testid="password-prompt-description">
        {description}
      </p>
      {waiting > 0 && (
        <p className="password-prompt__queue" data-testid="password-prompt-queue">
          {waitingText}
        </p>
      )}
      <PasswordInput
        className="ui-input"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={inputPlaceholder}
        aria-label={inputAriaLabel}
        autoFocus
        data-testid="password-prompt-input"
      />
      {showSave && (
        <label className="password-prompt__save-label" data-testid="password-prompt-save-label">
          <Checkbox
            checked={savePassword}
            onCheckedChange={setSavePassword}
            aria-label={saveLabel}
            data-testid="password-prompt-save-checkbox"
          />
          <span>{saveLabel}</span>
        </label>
      )}
    </Modal>
  );
}
