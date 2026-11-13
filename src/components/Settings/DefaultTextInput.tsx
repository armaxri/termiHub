import { Button, Input } from "@/components/ui";
import "./DefaultNumberInput.css";

export interface DefaultTextInputProps {
  /** The stored value; `undefined` means "unset — follow the default". */
  value: string | undefined;
  /** Short placeholder naming the default, e.g. "Default font chain". */
  defaultLabel: string;
  /** Called with the new value, or `undefined` when the field is cleared or reset. */
  onChange: (value: string | undefined) => void;
  /** Accessible name of the input; {@link SettingsField} injects it from its label. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "data-testid"?: string;
}

/**
 * A text setting whose unset value follows a built-in default (#5561), the
 * text twin of {@link DefaultNumberInput}. Unset, the input is empty with a
 * short placeholder and a "Default" marker, so a long default (the Nerd Font
 * chain) never reads as the user's own value; set, a "Reset" button clears it.
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
  const isDefault = value === undefined || value === "";
  const name = ariaLabel ?? "setting";
  return (
    <div className="settings-default-number" data-testid={testId}>
      <Input
        className="settings-default-number__input"
        value={value ?? ""}
        placeholder={defaultLabel}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
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
          aria-label={`Reset ${name.toLowerCase()} to the default`}
          data-testid={testId ? `${testId}-reset` : undefined}
        >
          Reset
        </Button>
      )}
    </div>
  );
}
