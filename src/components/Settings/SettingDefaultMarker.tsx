import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";
import "./SettingDefaultMarker.css";

export interface SettingDefaultMarkerProps {
  /** Whether the setting currently follows its built-in default. */
  isDefault: boolean;
  /** Returns the setting to its default (stores "unset"). */
  onReset: () => void;
  /** The field's visible label, used in the reset button's accessible name. */
  name: string;
  /** The default value as shown to the user (e.g. "14"); omitted for long defaults. */
  defaultText?: string;
  /** Prefix for the `-default` tag and `-reset` button test ids. */
  "data-testid"?: string;
}

/**
 * The label-row marker of a setting that follows a built-in default (#5632).
 * At the default it is a small, non-interactive "Default" tag; once the value
 * is overridden it becomes an explicit "Reset to default" button. It sits on
 * the label row (via `SettingsField`'s `labelAccessory`), so the control below
 * spans the same width as every other control on the page.
 */
export function SettingDefaultMarker({
  isDefault,
  onReset,
  name,
  defaultText,
  "data-testid": testId,
}: SettingDefaultMarkerProps) {
  if (isDefault) {
    return (
      <span
        className="settings-default-marker__tag"
        data-testid={testId ? `${testId}-default` : undefined}
      >
        Default
      </span>
    );
  }
  const suffix = defaultText !== undefined ? ` (${defaultText})` : "";
  return (
    <Button
      variant="ghost"
      size="sm"
      className="settings-default-marker__reset"
      icon={<RotateCcw size={12} aria-hidden="true" />}
      onClick={onReset}
      aria-label={`Reset ${name.toLowerCase()} to the default${suffix}`}
      data-testid={testId ? `${testId}-reset` : undefined}
    >
      Reset to default
    </Button>
  );
}
