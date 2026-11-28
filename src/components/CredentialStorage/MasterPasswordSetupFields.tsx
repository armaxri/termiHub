import { useId } from "react";
import { Check, Circle, TriangleAlert } from "lucide-react";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Field } from "@/components/ui";
import {
  MASTER_PASSWORD_MISMATCH_TEXT,
  MIN_MASTER_PASSWORD_LENGTH,
  masterPasswordRequirementHint,
  showMasterPasswordMismatch,
} from "@/utils/masterPasswordValidation";
import { MASTER_PASSWORD_NOT_RECOVERABLE_TEXT } from "@/utils/credentialStorageCopy";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./CredentialStorageChooser.css";

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
  /**
   * Show one live checklist under the second field — enough characters,
   * passwords match — instead of the hint under the first field and the
   * mismatch line (#5825). For a host whose submit stays disabled until both
   * are met, so the list says why.
   */
  checklist?: boolean;
}

/**
 * The master-password setup inputs — new password, confirmation, inline error —
 * shared by Settings ▸ Security and the first-use storage chooser (#5187), so
 * both set up the vault the same way.
 *
 * A one-line warning callout leads the inputs: a forgotten master password
 * cannot be recovered, and that must not hide in a grey paragraph (#5560).
 *
 * Each input has a persistent label (not a placeholder that disappears once
 * typed into), the first carries a live requirements hint, and the second an
 * inline mismatch error (#5552). With `checklist`, both requirements are one
 * live checklist under the second field instead (#5825).
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
  checklist = false,
}: MasterPasswordSetupFieldsProps) {
  const baseId = useId();
  const passwordId = `${baseId}-password`;
  const confirmId = `${baseId}-confirm`;
  const hintId = `${baseId}-hint`;
  const checklistId = `${baseId}-checklist`;
  const requirement = masterPasswordRequirementHint(password);
  const mismatch = !checklist && showMasterPasswordMismatch(password, confirm);
  // The live mismatch line already says it; do not repeat it as the submit error.
  const submitError =
    error && !((mismatch || checklist) && error === MASTER_PASSWORD_MISMATCH_TEXT) ? error : "";
  const longEnough = password.length >= MIN_MASTER_PASSWORD_LENGTH;
  const matches = password.length > 0 && password === confirm;

  return (
    <>
      <p className="credential-storage-warning" role="note" data-testid={`${testIdPrefix}-warning`}>
        <TriangleAlert
          size={ICON_SIZE.sm}
          className="credential-storage-warning__icon"
          aria-hidden="true"
        />
        <span>{MASTER_PASSWORD_NOT_RECOVERABLE_TEXT}</span>
      </p>
      <Field
        label="Master password"
        htmlFor={passwordId}
        hint={
          checklist ? undefined : (
            <span
              id={hintId}
              data-testid={`${testIdPrefix}-hint`}
              data-met={requirement.met || undefined}
            >
              {requirement.text}
            </span>
          )
        }
        data-testid={`${testIdPrefix}-field`}
      >
        <PasswordInput
          id={passwordId}
          className={inputClassName}
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          aria-describedby={checklist ? checklistId : hintId}
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
          aria-describedby={checklist ? checklistId : undefined}
          data-testid={`${testIdPrefix}-confirm-input`}
        />
      </Field>
      {checklist && (
        <ul
          id={checklistId}
          className="master-password-checklist"
          aria-label="Master password requirements"
          data-testid={`${testIdPrefix}-checklist`}
        >
          <ChecklistItem
            met={longEnough}
            text={`At least ${MIN_MASTER_PASSWORD_LENGTH} characters`}
            testId={`${testIdPrefix}-checklist-length`}
          />
          <ChecklistItem
            met={matches}
            text="Passwords match"
            testId={`${testIdPrefix}-checklist-match`}
          />
        </ul>
      )}
      {submitError && (
        <p className={errorClassName} role="alert" data-testid={`${testIdPrefix}-error`}>
          {submitError}
        </p>
      )}
    </>
  );
}

/** One live requirement of {@link MasterPasswordSetupFields}' checklist (#5825). */
function ChecklistItem({ met, text, testId }: { met: boolean; text: string; testId: string }) {
  const Icon = met ? Check : Circle;
  return (
    <li
      className="master-password-checklist__item"
      data-met={met || undefined}
      data-testid={testId}
    >
      <Icon size={ICON_SIZE.xs} className="master-password-checklist__icon" aria-hidden="true" />
      <span>{text}</span>
      <span className="sr-only">{met ? " (done)" : " (not yet)"}</span>
    </li>
  );
}
