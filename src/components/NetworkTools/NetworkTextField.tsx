import type { Ref } from "react";

interface NetworkTextFieldProps {
  /** Field label text. */
  label: string;
  /** Current value. */
  value: string;
  /** Change handler receiving the raw string. */
  onChange: (value: string) => void;
  /** Inline validation message; when set, the field renders its error state. */
  error?: string | null;
  /** Apply the `--small` compact width modifier. */
  small?: boolean;
  /** Placeholder shown when empty. */
  placeholder?: string;
  /** Ref forwarded to the underlying input (e.g. to autofocus the primary field). */
  inputRef?: Ref<HTMLInputElement>;
  /** Test hook forwarded to the input. */
  "data-testid"?: string;
}

/**
 * A labelled text input for the network tools panels with inline validation
 * feedback — the text counterpart to {@link NetworkNumberField}, so the error
 * class + `aria-invalid` + error message live in one place.
 */
export function NetworkTextField({
  label,
  value,
  onChange,
  error,
  small,
  placeholder,
  inputRef,
  "data-testid": testId,
}: NetworkTextFieldProps) {
  return (
    <label className={`network-panel__field${small ? " network-panel__field--small" : ""}`}>
      <span>{label}</span>
      <input
        ref={inputRef}
        className={`network-panel__input${error ? " network-panel__input--error" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        data-testid={testId}
      />
      {error && <span className="network-panel__field-error">{error}</span>}
    </label>
  );
}
