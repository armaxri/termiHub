interface NetworkNumberFieldProps {
  /** Field label text. */
  label: string;
  /** Current value; `""` represents an empty input. */
  value: number | "";
  /** Change handler receiving the parsed number, or `""` when cleared. */
  onChange: (value: number | "") => void;
  /** Inline validation message; when set, the field renders its error state. */
  error?: string | null;
  /** Apply the `--small` compact width modifier. */
  small?: boolean;
  /** Placeholder shown when empty. */
  placeholder?: string;
  /** Native `min` attribute (spinner hint only; real validation is `error`). */
  min?: number;
  /** Test hook forwarded to the input. */
  "data-testid"?: string;
}

/**
 * A labelled numeric input for the network tools panels with inline validation
 * feedback. Keeps the value as `number | ""` so a cleared field reads blank
 * (and can be flagged "required") instead of silently coercing to 0.
 */
export function NetworkNumberField({
  label,
  value,
  onChange,
  error,
  small,
  placeholder,
  min,
  "data-testid": testId,
}: NetworkNumberFieldProps) {
  return (
    <label className={`network-panel__field${small ? " network-panel__field--small" : ""}`}>
      <span>{label}</span>
      <input
        className={`network-panel__input${error ? " network-panel__input--error" : ""}`}
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        placeholder={placeholder}
        min={min}
        aria-invalid={error ? true : undefined}
        data-testid={testId}
      />
      {error && <span className="network-panel__field-error">{error}</span>}
    </label>
  );
}
