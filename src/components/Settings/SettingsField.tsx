import type { ReactElement, ReactNode } from "react";
import { Field } from "../ui/Field";
import type { FieldHintVariant } from "../ui/Field";

/** Visual variant applied to the field's hint text. */
export type SettingsHintVariant = FieldHintVariant;

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
   * Optional resolved validation message. When set, an inline error is rendered
   * below the control and the control is marked `aria-invalid` and linked to the
   * message via `aria-describedby`.
   */
  error?: ReactNode;
  /**
   * The single control the field wraps (a `Toggle`, `Select`, `input`, etc.).
   * Its `aria-label` is set from {@link SettingsFieldProps.label} unless the
   * control already declares its own.
   */
  children: ReactElement;
}

/**
 * Thin settings-panel binding of the shared {@link Field} primitive: renders the
 * `settings-form__field` label/control/hint scaffold and wires the control's
 * accessible name from the label. It is `Field` with `variant="settings"` and no
 * `htmlFor`, kept as a named wrapper so the many Settings call sites read as
 * `<SettingsField>` and share a single field implementation.
 */
export function SettingsField({
  label,
  hint,
  hintVariant = "default",
  error,
  children,
}: SettingsFieldProps): ReactElement {
  return (
    <Field variant="settings" label={label} hint={hint} hintVariant={hintVariant} error={error}>
      {children}
    </Field>
  );
}
