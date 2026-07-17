import React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import "./ui.css";

/**
 * The state a {@link Checkbox} can display. `"indeterminate"` is the mixed
 * state of a parent whose children are only partly checked; it is a state the
 * consumer sets, never one the user can select.
 */
export type CheckboxChecked = boolean | "indeterminate";

/**
 * Props for the shared {@link Checkbox} primitive — a token-styled skin over
 * `@radix-ui/react-checkbox`, so real `role="checkbox"`, `aria-checked`
 * (including `mixed`), Space activation, and focus handling come from Radix
 * rather than a hand-rolled control.
 */
export interface CheckboxProps {
  /** Controlled state. Pass `"indeterminate"` for the mixed state. */
  checked: CheckboxChecked;
  /**
   * Called with the next value when the user toggles the box. Always a
   * boolean: activating an indeterminate checkbox resolves it to `true`, so
   * `"indeterminate"` is never echoed back to the consumer.
   */
  onCheckedChange: (checked: boolean) => void;
  /** Disable interaction. */
  disabled?: boolean;
  /** Accessible label (use when there is no associated visible `<label>`). */
  "aria-label"?: string;
  /** Associates the checkbox with a `<label htmlFor>`. */
  id?: string;
  /** Test hook forwarded to the checkbox root. */
  "data-testid"?: string;
}

/**
 * The single shared checkbox primitive.
 *
 * Prefer this over {@link Toggle} for booleans that take effect on confirm —
 * a checkbox conventionally means "applies when you press OK", where a switch
 * means "applies immediately". Checked = `--accent-color` with a tick;
 * indeterminate shows a dash.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  id,
  ...rest
}: CheckboxProps): React.ReactElement {
  return (
    <CheckboxPrimitive.Root
      id={id}
      className="ui-checkbox"
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next === true)}
      disabled={disabled}
      {...rest}
    >
      <CheckboxPrimitive.Indicator className="ui-checkbox__indicator">
        {checked === "indeterminate" ? (
          <Minus size={10} strokeWidth={3} aria-hidden="true" />
        ) : (
          <Check size={10} strokeWidth={3} aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
