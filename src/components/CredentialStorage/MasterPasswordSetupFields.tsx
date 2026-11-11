import { PasswordInput } from "@/components/PasswordInput/PasswordInput";

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
  return (
    <>
      <PasswordInput
        className={inputClassName}
        placeholder="Master password"
        aria-label="Master password"
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        autoFocus
        data-testid={`${testIdPrefix}-input`}
      />
      <PasswordInput
        className={inputClassName}
        placeholder="Confirm password"
        aria-label="Confirm master password"
        value={confirm}
        onChange={(e) => onConfirmChange(e.target.value)}
        data-testid={`${testIdPrefix}-confirm-input`}
      />
      {error && (
        <p className={errorClassName} role="alert" data-testid={`${testIdPrefix}-error`}>
          {error}
        </p>
      )}
    </>
  );
}
