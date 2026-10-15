import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { Field } from "../ui/Field";
import type { FieldHintVariant } from "../ui/Field";
import { Button } from "../ui/Button";
import { Toggle } from "../ui/Toggle";

/** Visual variant applied to the field's hint text. */
export type SettingsHintVariant = FieldHintVariant;

/**
 * Settings row layout. `"inline"` puts the label and its hint on the left and the
 * control right-aligned (toggles, action buttons); `"stack"` renders label, then
 * the control, then the hint (inputs, selects).
 */
export type SettingsFieldLayout = "stack" | "inline";

/** Controls compact enough to sit right-aligned beside their label. */
const INLINE_CONTROLS: ReadonlySet<unknown> = new Set([Toggle, Button]);

/**
 * Pick the row layout for a settings control: a {@link Toggle} or a single
 * {@link Button} renders inline; everything else (inputs, selects, composite
 * controls) stacks.
 */
export function settingsFieldLayout(control: ReactNode): SettingsFieldLayout {
  return isValidElement(control) && INLINE_CONTROLS.has(control.type) ? "inline" : "stack";
}

export interface SettingsFieldProps {
  /**
   * The visible field label. Also derives the control's `aria-label` so the
   * label text is stated once per field instead of being repeated as a manual
   * `aria-label` at each call site.
   */
  label: string;
  /**
   * Optional `id` of the control. When set, a real `<label htmlFor>` points at
   * it (so clicking the label focuses/activates the control) and the control's
   * accessible name comes from that label instead of a derived `aria-label`.
   */
  htmlFor?: string;
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
  /**
   * Row layout. Defaults to {@link settingsFieldLayout} of the child: inline for
   * a `Toggle` or `Button`, stacked for everything else.
   */
  layout?: SettingsFieldLayout;
}

/**
 * Thin settings-panel binding of the shared {@link Field} primitive: renders the
 * `settings-form__field` label/control/hint scaffold and wires the control's
 * accessible name from the label. It is `Field` with `variant="settings"` (and an
 * optional `htmlFor`), kept as a named wrapper so the many Settings call sites read as
 * `<SettingsField>` and share a single field implementation.
 */
export function SettingsField({
  label,
  htmlFor,
  hint,
  hintVariant = "default",
  error,
  children,
  layout,
}: SettingsFieldProps): ReactElement {
  return (
    <Field
      variant="settings"
      layout={layout ?? settingsFieldLayout(children)}
      label={label}
      htmlFor={htmlFor}
      hint={hint}
      hintVariant={hintVariant}
      error={error}
    >
      {children}
    </Field>
  );
}
