import { useId } from "react";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Field } from "@/components/ui";
import {
  MASTER_PASSWORD_MISMATCH_TEXT,
  masterPasswordRequirementHint,
  showMasterPasswordMismatch,
} from "@/utils/masterPasswordValidation";

interface MasterPasswordSetupFieldsProps {
  password: string;
  confirm: string;
  onPasswordChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
  /** Inline validation or setup error, shown under the inputs. */
  error?: string;
  /** Class applied to each input (the host's input style). */
  inputClassName: string;
  /** Class applied to the error line. */
  errorClassName: string;
  /** Prefix of the inputs' test ids: `<prefix>-input` / `<prefix>-confirm-input`. */
  testIdPrefix?: string;
}

/**
 * The master-password setup inputs — new password, confirmation, inline error —
 * shared by Settings ▸ Security and the first-use storage chooser (#5187), so
 * both set up the vault the same way.
 *
 * Each input has a persistent label (not a placeholder that disappears once
 * typed into), the first carries a live requirements hint, and the second an
 * inline mismatch error (#5552).
 */
export function MasterPasswordSetupFields({
  password,
  confirm,
  onPasswordChange,
  onConfirmChange,
  error,
  inputClassName,
  errorClassName,
  testIdPrefix = "master-password",
}: MasterPasswordSetupFieldsProps) {
  const baseId = useId();
  const passwordId = `${baseId}-password`;
  const confirmId = `${baseId}-confirm`;
  const hintId = `${baseId}-hint`;
  const requirement = masterPasswordRequirementHint(password);
  const mismatch = showMasterPasswordMismatch(password, confirm);
  // The live mismatch line already says it; do not repeat it as the submit error.
  const submitError = error && !(mismatch && error === MASTER_PASSWORD_MISMATCH_TEXT) ? error : "";

  return (
    <>
      <Field
        label="Master password"
        htmlFor={passwordId}
        hint={
          <span
            id={hintId}
            data-testid={`${testIdPrefix}-hint`}
            data-met={requirement.met || undefined}
          >
            {requirement.text}
          </span>
        }
        data-testid={`${testIdPrefix}-field`}
      >
        <PasswordInput
          id={passwordId}
          className={inputClassName}
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          aria-describedby={hintId}
          autoFocus
          data-testid={`${testIdPrefix}-input`}
        />
      </Field>
      <Field
        label="Confirm password"
        htmlFor={confirmId}
        error={mismatch ? MASTER_PASSWORD_MISMATCH_TEXT : undefined}
        errorTestId={`${testIdPrefix}-mismatch`}
        data-testid={`${testIdPrefix}-confirm-field`}
      >
        <PasswordInput
          id={confirmId}
          className={inputClassName}
          value={confirm}
          onChange={(e) => onConfirmChange(e.target.value)}
          data-testid={`${testIdPrefix}-confirm-input`}
        />
      </Field>
      {submitError && (
        <p className={errorClassName} role="alert" data-testid={`${testIdPrefix}-error`}>
          {submitError}
        </p>
      )}
    </>
  );
}
