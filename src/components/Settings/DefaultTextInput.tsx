import { Input } from "@/components/ui";
import "./SettingDefaultMarker.css";

export interface DefaultTextInputProps {
  /** The stored value; `undefined` means "unset — follow the default". */
  value: string | undefined;
  /** Short placeholder naming the default, e.g. "Default font chain". */
  defaultLabel: string;
  /** Called with the new value, or `undefined` when the field is cleared. */
  onChange: (value: string | undefined) => void;
  /** Accessible name of the input; {@link SettingsField} injects it from its label. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Prefix of the input's `-input` test id. */
  "data-testid"?: string;
}

/**
 * A text setting whose unset value follows a built-in default (#5561), the
 * text twin of {@link DefaultNumberInput}. Unset, the input is empty with a
 * short, italic placeholder, so a long default (the Nerd Font chain) never
 * reads as the user's own value. The "Default" tag / "Reset to default" button
 * lives on the label row ({@link SettingDefaultMarker}, #5632).
 */
export function DefaultTextInput({
  value,
  defaultLabel,
  onChange,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "data-testid": testId,
}: DefaultTextInputProps) {
  return (
    <Input
      className="settings-default-text__input"
      value={value ?? ""}
      placeholder={defaultLabel}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      data-testid={testId ? `${testId}-input` : undefined}
    />
  );
}
