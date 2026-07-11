import { cloneElement } from "react";
import type { ReactElement, ReactNode } from "react";

/** Visual variant applied to the field's hint text. */
export type SettingsHintVariant = "default" | "warning";

export interface SettingsFieldProps {
  /**
   * The visible field label. Also derives the control's `aria-label` so the
   * label text is stated once per field instead of being repeated as a manual
   * `aria-label` at each call site.
   */
  label: string;
  /** Optional explanatory hint rendered below the control. */
  hint?: ReactNode;
  /** Hint styling — `"warning"` colors the hint as a caution. Defaults to `"default"`. */
  hintVariant?: SettingsHintVariant;
  /**
   * The single control the field wraps (a `Toggle`, `Select`, `input`, etc.).
   * Its `aria-label` is set from {@link SettingsFieldProps.label} unless the
   * control already declares its own.
   */
  children: ReactElement<{ "aria-label"?: string }>;
}

/**
 * Shared wrapper for a Settings panel field: renders the `settings-form__field`
 * label/control/hint scaffold once and wires the control's accessible name from
 * the label, collapsing the field markup that every Settings panel used to
 * hand-repeat.
 */
export function SettingsField({
  label,
  hint,
  hintVariant = "default",
  children,
}: SettingsFieldProps): ReactElement {
  const control =
    children.props["aria-label"] === undefined
      ? cloneElement(children, { "aria-label": label })
      : children;

  const hintClassName =
    hintVariant === "warning"
      ? "settings-form__hint settings-form__hint--warning"
      : "settings-form__hint";

  return (
    <div className="settings-form__field">
      <span className="settings-form__label">{label}</span>
      {control}
      {hint !== undefined && hint !== null && <span className={hintClassName}>{hint}</span>}
    </div>
  );
}
