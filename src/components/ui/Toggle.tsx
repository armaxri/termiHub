import React from "react";
import * as Switch from "@radix-ui/react-switch";
import "./ui.css";

/**
 * Props for the shared {@link Toggle} primitive — a token-styled skin over
 * `@radix-ui/react-switch`, so real `role="switch"`, `aria-checked`, and
 * keyboard toggling come from Radix rather than a hand-rolled control.
 */
export interface ToggleProps {
  /** Controlled on/off state. */
  checked: boolean;
  /** Called with the next boolean value when the user flips the switch. */
  onCheckedChange: (checked: boolean) => void;
  /** Disable interaction. */
  disabled?: boolean;
  /** Accessible label (use when there is no associated visible `<label>`). */
  "aria-label"?: string;
  /** Associates the switch with a `<label htmlFor>`. */
  id?: string;
  /** Test hook forwarded to the switch root. */
  "data-testid"?: string;
}

/**
 * The single shared toggle primitive. On = `--accent-color`; the thumb slides
 * via `--transition-fast` (disabled under reduced-motion). Prefer this over any
 * bespoke checkbox-styled control.
 */
export function Toggle({
  checked,
  onCheckedChange,
  disabled,
  id,
  ...rest
}: ToggleProps): React.ReactElement {
  return (
    <Switch.Root
      id={id}
      className="ui-toggle"
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      {...rest}
    >
      <Switch.Thumb className="ui-toggle__thumb" />
    </Switch.Root>
  );
}
