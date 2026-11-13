import { useState } from "react";
import { Input } from "@/components/ui";

export interface DefaultNumberInputProps {
  /** The stored value; `undefined` means "unset — follow the default". */
  value: number | undefined;
  /** The effective value used while the setting is unset. */
  defaultValue: number;
  /**
   * Called with the new value, or `undefined` when the field is cleared or the
   * default value is typed back in (so "unset" keeps meaning "follow the default").
   */
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Accessible name of the input; {@link SettingsField} injects it from its label. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Prefix of the input's `-input` test id. */
  "data-testid"?: string;
}

/** Number of digits after the decimal point in `n`'s plain string form. */
function decimals(n: number): number {
  return String(n).split(".")[1]?.length ?? 0;
}

/**
 * Format a numeric setting for display: padded to the step's precision (a
 * line height of `1` with step `0.1` reads "1.0", like its hint) but never
 * rounding away the value's own decimals.
 */
export function formatSettingNumber(n: number, step?: number): string {
  const places = step === undefined ? 0 : decimals(step);
  return decimals(n) >= places ? String(n) : n.toFixed(places);
}

/** Whether a stored numeric setting follows its default. */
export function isAtDefault(value: number | undefined, defaultValue: number): boolean {
  return value === undefined || value === defaultValue;
}

/**
 * A numeric setting whose unset value follows a built-in default (#5554,
 * #5632). The input always shows the value in effect as real, full-contrast
 * text — the stored value, or the default while unset — never as placeholder
 * grey. While focused it holds the raw draft, so the field can be cleared and
 * retyped; clearing it (or typing the default) returns the setting to the
 * default. The "Default" tag / "Reset to default" button lives on the label
 * row ({@link SettingDefaultMarker}), so the control spans the full width.
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
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? formatSettingNumber(value ?? defaultValue, step);

  const handleChange = (text: string) => {
    setDraft(text);
    if (text === "") {
      onChange(undefined);
      return;
    }
    const parsed = Number(text);
    onChange(parsed === defaultValue ? undefined : parsed);
  };

  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      value={shown}
      onFocus={() => setDraft(shown)}
      onBlur={() => setDraft(null)}
      onChange={(e) => handleChange(e.target.value)}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      data-testid={testId ? `${testId}-input` : undefined}
    />
  );
}
