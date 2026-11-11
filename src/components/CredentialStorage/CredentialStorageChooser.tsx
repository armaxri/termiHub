import { useCallback, useState } from "react";
import { Shield } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { CredentialStorageMode } from "@/types/credential";
import { markCredentialStorageChosen, switchCredentialStore } from "@/services/api";
import { Button, Modal, RadioGroup } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import { validateNewMasterPassword } from "@/utils/masterPasswordValidation";
import {
  CREDENTIAL_STORAGE_CHANGE_LATER_TEXT,
  CREDENTIAL_STORAGE_CHOICES,
  CREDENTIAL_STORAGE_CHOOSER_TITLE,
} from "@/utils/credentialStorageCopy";
import { MasterPasswordSetupFields } from "./MasterPasswordSetupFields";
import "./CredentialStorageChooser.css";

/** The chooser opens on the OS keychain: strongest, nothing extra to unlock. */
const DEFAULT_CHOICE: CredentialStorageMode = "os_keychain";

type Step = "choose" | "master_password";

/**
 * The one-time "Where should termiHub keep passwords?" chooser (#5187), shown
 * the first time a secret is about to be saved while no storage choice exists.
 *
 * - OS Keychain (pre-selected) switches the store and settles.
 * - Master Password first routes through the master-password setup (the same
 *   fields Settings ▸ Security uses); the vault is created on confirm.
 * - "Don't save passwords" records the choice and keeps storage off.
 * - Cancel / Escape / × settle `"canceled"`: nothing is chosen, nothing is
 *   saved, and the next save asks again.
 *
 * Nothing is written to any store here — the chooser only sets the store up.
 * The waiting save flow writes the secret afterwards through its usual path,
 * so a secret never lands in a store the user did not confirm.
 */
export function CredentialStorageChooser() {
  const open = useAppStore((s) => s.storageChooserOpen);
  const resolveStorageChoice = useAppStore((s) => s.resolveStorageChoice);
  const loadCredentialStoreStatus = useAppStore((s) => s.loadCredentialStoreStatus);
  const setCredentialStoreStatus = useAppStore((s) => s.setCredentialStoreStatus);

  const [choice, setChoice] = useState<CredentialStorageMode>(DEFAULT_CHOICE);
  const [step, setStep] = useState<Step>("choose");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [shownOpen, setShownOpen] = useState(open);

  // Reset whenever the chooser opens, during render so a stale choice or a
  // typed master password never shows for a frame.
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setChoice(DEFAULT_CHOICE);
      setStep("choose");
      setPassword("");
      setConfirm("");
      setError("");
    }
  }

  const cancel = useCallback(() => resolveStorageChoice("canceled"), [resolveStorageChoice]);

  const handleContinue = useCallback(async () => {
    if (choice === "master_password" && step === "choose") {
      setError("");
      setStep("master_password");
      return;
    }
    setError("");
    try {
      if (choice === "none") {
        setCredentialStoreStatus(await markCredentialStorageChosen());
      } else {
        let masterPassword: string | undefined;
        if (choice === "master_password") {
          const invalid = validateNewMasterPassword(password, confirm);
          if (invalid) throw new Error(invalid);
          masterPassword = password;
        }
        const result = await switchCredentialStore(choice, masterPassword);
        if (result.rolledBack || result.status === "failed") {
          throw new Error(result.warnings[0] ?? "The credential store could not be set up.");
        }
        await loadCredentialStoreStatus();
      }
      resolveStorageChoice(choice);
    } catch (err) {
      setError(errorMessage(err));
      // Keep the async Button in its error path; the inline error is the feedback.
      throw err;
    }
  }, [
    choice,
    step,
    password,
    confirm,
    loadCredentialStoreStatus,
    setCredentialStoreStatus,
    resolveStorageChoice,
  ]);

  const settingUpVault = step === "master_password";

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      title={settingUpVault ? "Set a master password" : CREDENTIAL_STORAGE_CHOOSER_TITLE}
      data-testid="credential-storage-chooser"
      footer={
        <>
          {settingUpVault ? (
            <Button
              variant="secondary"
              onClick={() => {
                setError("");
                setStep("choose");
              }}
              data-testid="credential-storage-chooser-back"
            >
              Back
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={cancel}
              data-testid="credential-storage-chooser-cancel"
            >
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            onClick={handleContinue}
            errorToast={false}
            pendingLabel="Setting up…"
            data-testid="credential-storage-chooser-continue"
          >
            {settingUpVault ? "Create vault" : "Continue"}
          </Button>
        </>
      }
    >
      <div className="credential-storage-chooser">
        {settingUpVault ? (
          <>
            <p className="credential-storage-chooser__text">
              Choose a strong password to encrypt your saved passwords. termiHub asks for it once
              per session to unlock the vault. It cannot be recovered if you forget it.
            </p>
            <div data-testid="credential-storage-chooser-master-password-setup">
              <MasterPasswordSetupFields
                password={password}
                confirm={confirm}
                onPasswordChange={setPassword}
                onConfirmChange={setConfirm}
                error={error}
                inputClassName="ui-input credential-storage-chooser__input"
                errorClassName="credential-storage-chooser__error"
                testIdPrefix="credential-storage-chooser-master-password"
              />
            </div>
          </>
        ) : (
          <>
            <p className="credential-storage-chooser__text">
              termiHub can save passwords and passphrases so you don&apos;t have to type them each
              time.
            </p>
            <RadioGroup
              variant="cards"
              value={choice}
              onValueChange={(v) => {
                setError("");
                setChoice(v as CredentialStorageMode);
              }}
              aria-label="Where to keep passwords"
              data-testid="credential-storage-chooser-options"
              options={CREDENTIAL_STORAGE_CHOICES.map((option) => ({
                value: option.mode,
                label: (
                  <>
                    <Shield size={14} aria-hidden="true" />
                    <span>{option.label}</span>
                    {option.badge && (
                      <span className="credential-storage-chooser__badge">{option.badge}</span>
                    )}
                  </>
                ),
                description: option.description,
                "data-testid": `credential-storage-chooser-option-${option.mode}`,
              }))}
            />
            {error && (
              <p
                className="credential-storage-chooser__error"
                role="alert"
                data-testid="credential-storage-chooser-error"
              >
                {error}
              </p>
            )}
            <p
              className="credential-storage-chooser__hint"
              data-testid="credential-storage-chooser-change-later"
            >
              {CREDENTIAL_STORAGE_CHANGE_LATER_TEXT}
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
