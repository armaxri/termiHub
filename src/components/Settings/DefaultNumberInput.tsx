import { Button, NumberInput } from "@/components/ui";
import "./DefaultNumberInput.css";

export interface DefaultNumberInputProps {
  /** The stored value; `undefined` means "unset — follow the default". */
  value: number | undefined;
  /** The effective value used while the setting is unset. */
  defaultValue: number;
  /** Called with the new value, or `undefined` when the field is cleared or reset. */
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Accessible name of the input; {@link SettingsField} injects it from its label. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "data-testid"?: string;
}

/**
 * A numeric setting whose unset value follows a built-in default (#5554). The
 * input never reads blank: unset, it shows the effective default as its
 * placeholder with a "Default" marker; set, a "Reset" button returns it to
 * the default. Clearing the input also returns it to the default, so "unset"
 * keeps meaning "follow the default".
 */
export function DefaultNumberInput({
  value,
  defaultValue,
  onChange,
  min,
  max,
  step,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "data-testid": testId,
}: DefaultNumberInputProps) {
  const isDefault = value === undefined;
  const name = ariaLabel ?? "setting";
  return (
    <div className="settings-default-number" data-testid={testId}>
      <NumberInput
        className="settings-default-number__input"
        min={min}
        max={max}
        step={step}
        value={value ?? ""}
        placeholder={String(defaultValue)}
        onValueChange={(v) => onChange(v === "" ? undefined : v)}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        data-testid={testId ? `${testId}-input` : undefined}
      />
      {isDefault ? (
        <span
          className="settings-default-number__badge"
          data-testid={testId ? `${testId}-default` : undefined}
        >
          Default
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(undefined)}
          aria-label={`Reset ${name.toLowerCase()} to the default (${defaultValue})`}
          data-testid={testId ? `${testId}-reset` : undefined}
        >
          Reset
        </Button>
      )}
    </div>
  );
}
