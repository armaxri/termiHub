import { useState } from "react";
import { Eye, EyeOff, AlertTriangle } from "lucide-react";
import "./PasswordInput.css";

interface PasswordInputProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  id?: string;
  disabled?: boolean;
  "data-testid"?: string;
}

/**
 * Password input with a visibility toggle button and a Caps Lock warning.
 * Drop-in replacement for `<input type="password">`.
 *
 * The Caps Lock indicator (#1360) is detected from `getModifierState("CapsLock")`
 * on key events and cleared on blur. It is announced via an assertive live region
 * so screen-reader users are told when an inadvertent Caps Lock is likely behind a
 * rejected password (a common cause of "Incorrect master password" / failed
 * SSH connects). Because this lives in the shared component, the warning appears
 * everywhere passwords are entered — unlock, connect, and change-password flows.
 */
export function PasswordInput({
  value,
  onChange,
  onKeyDown,
  placeholder,
  autoFocus,
  className,
  id,
  disabled,
  "data-testid": dataTestId,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);

  const syncCapsLock = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLockOn(e.getModifierState("CapsLock"));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    syncCapsLock(e);
    onKeyDown?.(e);
  };

  const capsTestId = dataTestId ? `${dataTestId}-caps-lock` : undefined;

  return (
    <div className="password-input">
      <input
        id={id}
        className={className}
        type={visible ? "text" : "password"}
        value={value}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        onKeyUp={syncCapsLock}
        onBlur={() => setCapsLockOn(false)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        data-testid={dataTestId}
      />
      <button
        type="button"
        className="password-input__toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        title={visible ? "Hide password" : "Show password"}
        disabled={disabled}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
      {capsLockOn && !disabled && (
        <p
          className="password-input__caps-warning"
          role="alert"
          aria-live="assertive"
          data-testid={capsTestId}
        >
          <AlertTriangle size={12} aria-hidden="true" />
          <span>Caps Lock is on</span>
        </p>
      )}
    </div>
  );
}
