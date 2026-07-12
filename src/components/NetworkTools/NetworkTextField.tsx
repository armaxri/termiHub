import { useState, type Ref } from "react";

interface NetworkTextFieldProps {
  /** Field label text. */
  label: string;
  /** Current value. */
  value: string;
  /** Change handler receiving the raw string. */
  onChange: (value: string) => void;
  /** Inline validation message; surfaced once the field has been touched. */
  error?: string | null;
  /** Apply the `--small` compact width modifier. */
  small?: boolean;
  /** Placeholder shown when empty. */
  placeholder?: string;
  /** Ref forwarded to the underlying input (e.g. to autofocus the primary field). */
  inputRef?: Ref<HTMLInputElement>;
  /** Called when the input loses focus (fires after the field is marked touched). */
  onBlur?: () => void;
  /** Test hook forwarded to the input. */
  "data-testid"?: string;
}

/**
 * A labelled text input for the network tools panels with inline validation
 * feedback — the text counterpart to {@link NetworkNumberField}, so the error
 * class + `aria-invalid` + error message live in one place.
 *
 * The `error` is only surfaced once the user has touched the field (typed into
 * it or blurred it), so a pristine required field reads calm — the Run/Send
 * button stays disabled for the gating, and the inline message appears as soon
 * as the user engages.
 */
export function NetworkTextField({
  label,
  value,
  onChange,
  error,
  small,
  placeholder,
  inputRef,
  onBlur,
  "data-testid": testId,
}: NetworkTextFieldProps) {
  const [touched, setTouched] = useState(false);
  const showError = touched ? error : null;

  return (
    <label className={`network-panel__field${small ? " network-panel__field--small" : ""}`}>
      <span>{label}</span>
      <input
        ref={inputRef}
        className={`network-panel__input${showError ? " network-panel__input--error" : ""}`}
        value={value}
        onChange={(e) => {
          setTouched(true);
          onChange(e.target.value);
        }}
        onBlur={() => {
          setTouched(true);
          onBlur?.();
        }}
        placeholder={placeholder}
        aria-invalid={showError ? true : undefined}
        data-testid={testId}
      />
      {showError && <span className="network-panel__field-error">{showError}</span>}
    </label>
  );
}
