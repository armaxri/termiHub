import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { useAppStore } from "@/store/appStore";
import type { CredentialStorageMode } from "@/types/credential";
import { markCredentialStorageChosen, switchCredentialStore } from "@/services/api";
import { Button, Modal, RadioGroup, toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import { validateNewMasterPassword } from "@/utils/masterPasswordValidation";
import {
  CREDENTIAL_STORAGE_CHANGE_LATER_TEXT,
  CREDENTIAL_STORAGE_CHOOSER_TITLE,
} from "@/utils/credentialStorageCopy";
import { MasterPasswordSetupFields } from "./MasterPasswordSetupFields";
import { credentialStorageRadioOptions } from "./credentialStorageOptions";
import "./CredentialStorageChooser.css";

/** The chooser opens on the OS keychain: strongest, nothing extra to unlock. */
const DEFAULT_CHOICE: CredentialStorageMode = "os_keychain";

type Step = "choose" | "master_password";

/** One confirmation per settled choice (#5630), naming where passwords go. */
const CHOICE_CONFIRMATION: Record<CredentialStorageMode, string> = {
  os_keychain: "Passwords will be stored in the OS keychain.",
  master_password: "Passwords will be stored in your master-password vault.",
  none: "termiHub will not save passwords.",
};

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
 * - Focus opens on the selected option, never the × (#5550); Enter on an
 *   option or a password field presses the primary action.
 * - Create vault stays disabled until the master password is valid and
 *   confirmed; a settled choice is confirmed with one toast (#5630).
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
  const primaryRef = useRef<HTMLButtonElement>(null);
  // Each step's body sizes to its own content (#5630): carrying the choose
  // step's taller height over left an empty band above the vault footer.

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

  // Moving on to the vault step is synchronous on purpose: an async click
  // that resolves would flash the Button's green success state, which then
  // lingered on "Create vault" and on "Continue" after Back (#5551).
  const goToVaultStep = useCallback(() => {
    setError("");
    setStep("master_password");
  }, []);

  const handleContinue = useCallback(async () => {
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
      toast.success(CHOICE_CONFIRMATION[choice]);
    } catch (err) {
      setError(errorMessage(err));
      // Keep the async Button in its error path; the inline error is the feedback.
      throw err;
    }
  }, [
    choice,
    password,
    confirm,
    loadCredentialStoreStatus,
    setCredentialStoreStatus,
    resolveStorageChoice,
  ]);

  const settingUpVault = step === "master_password";
  const advancesToVaultStep = choice === "master_password" && !settingUpVault;
  // Create vault cannot succeed before both fields are valid and match, so it
  // says so by being disabled; the live hint and mismatch line say why (#5630).
  const vaultInvalid = settingUpVault && validateNewMasterPassword(password, confirm) !== null;

  // Radix radios swallow Enter (WAI-ARIA; they preventDefault it), and a lone
  // text field has no form to submit, so Enter there would do nothing. Route it to the primary action;
  // buttons keep their own Enter (Cancel must stay Cancel).
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    const target = e.target as HTMLElement;
    const isRadio = target.getAttribute("role") === "radio";
    const isTextField = target instanceof HTMLInputElement;
    if (!isRadio && !isTextField) return;
    e.preventDefault();
    primaryRef.current?.click();
  }, []);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      title={settingUpVault ? "Set a master password" : CREDENTIAL_STORAGE_CHOOSER_TITLE}
      data-testid="credential-storage-chooser"
      onKeyDown={handleKeyDown}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={cancel}
            data-testid="credential-storage-chooser-cancel"
          >
            Cancel
          </Button>
          {settingUpVault && (
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
          )}
          <Button
            // A fresh Button per step, so no async state carries across (#5551).
            key={step}
            ref={primaryRef}
            variant="primary"
            onClick={advancesToVaultStep ? goToVaultStep : handleContinue}
            disabled={vaultInvalid}
            errorToast={false}
            pendingLabel="Setting up…"
            data-testid="credential-storage-chooser-continue"
          >
            {settingUpVault ? "Create vault" : "Continue"}
          </Button>
        </>
      }
    >
      <div className="credential-storage-chooser" data-testid="credential-storage-chooser-body">
        {settingUpVault ? (
          <>
            <p className="credential-storage-chooser__text">
              Choose a strong password to encrypt your saved passwords. termiHub asks for it once
              per session to unlock the vault.
            </p>
            <div
              className="credential-storage-chooser__setup"
              data-testid="credential-storage-chooser-master-password-setup"
            >
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
              options={credentialStorageRadioOptions(
                (mode) => `credential-storage-chooser-option-${mode}`
              )}
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
