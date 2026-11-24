import { useId, useState } from "react";
import { Input } from "@/components/ui";
import { formatSettingNumber, joinIds, settingsNumberChars } from "./settingsNumber";
import { SettingsNumberFrame } from "./SettingsNumberFrame";

export { formatSettingNumber, isAtDefault } from "./settingsNumber";

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
  /** Unit shown after the input, e.g. "px" or "lines" (#5843). */
  unit?: string;
  /** Accessible name of the input; {@link SettingsField} injects it from its label. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Prefix of the input's `-input` test id. */
  "data-testid"?: string;
}

/**
 * A numeric setting whose unset value follows a built-in default (#5554,
 * #5632). The input always shows the value in effect as real, full-contrast
 * text — the stored value, or the default while unset — never as placeholder
 * grey. While focused it holds the raw draft, so the field can be cleared and
 * retyped; clearing it (or typing the default) returns the setting to the
 * default. The "Default" marker / "Reset to default" button lives on the label
 * row ({@link SettingDefaultMarker}). The input is sized to its value range
 * and followed by its unit ({@link SettingsNumberFrame}, #5843).
 */
export function DefaultNumberInput({
  value,
  defaultValue,
  onChange,
  min,
  max,
  step,
  unit,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "data-testid": testId,
}: DefaultNumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const unitId = useId();
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
    <SettingsNumberFrame
      chars={settingsNumberChars(min, max, step)}
      unit={unit}
      unitId={unitId}
      data-testid={testId}
    >
      <Input
        className="settings-number__input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={shown}
        onFocus={() => setDraft(shown)}
        onBlur={() => setDraft(null)}
        onChange={(e) => handleChange(e.target.value)}
        aria-label={ariaLabel}
        aria-describedby={joinIds(ariaDescribedBy, unit ? unitId : undefined)}
        aria-invalid={ariaInvalid}
        data-testid={testId ? `${testId}-input` : undefined}
      />
    </SettingsNumberFrame>
  );
}
