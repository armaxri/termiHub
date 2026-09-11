import React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import "./ui.css";

/** A single option for the declarative {@link RadioGroup} API. */
export interface RadioGroupOption {
  /** The value submitted when this option is chosen. */
  value: string;
  /** The human-readable label shown next to the radio. */
  label: React.ReactNode;
  /** Disable this individual option. */
  disabled?: boolean;
  /** Test hook forwarded to the option's radio control. */
  "data-testid"?: string;
}

/**
 * Props for the shared {@link RadioGroup} primitive — a token-styled skin over
 * `@radix-ui/react-radio-group`, so real `role="radiogroup"`, roving tabindex
 * (the group is a single tab stop; Arrow keys move between options),
 * `aria-checked`, and disabled handling come from Radix rather than a
 * hand-rolled set of `<input type="radio">`.
 *
 * The common case is the declarative `options` API. For richer options (cards,
 * nested inputs, per-option styling) pass `children` instead, composing the
 * exported {@link RadioGroupItem} inside your own layout.
 *
 * The group MUST be named: pass either `aria-label` or `aria-labelledby` so
 * assistive tech announces what the choice is about.
 */
export interface RadioGroupProps {
  /** Controlled selected value. */
  value: string | undefined;
  /** Called with the newly selected value. */
  onValueChange: (value: string) => void;
  /** Declarative option list. Ignored when `children` is provided. */
  options?: RadioGroupOption[];
  /** Custom item tree; overrides `options` for full control. */
  children?: React.ReactNode;
  /** Disable the whole group. */
  disabled?: boolean;
  /**
   * Visual/keyboard orientation. `vertical` (default) moves with Up/Down;
   * `horizontal` moves with Left/Right and lays options out in a row.
   */
  orientation?: "horizontal" | "vertical";
  /** Native form field name (rarely needed — Radix syncs a hidden input). */
  name?: string;
  /** Accessible label for the group (use when there is no visible group label). */
  "aria-label"?: string;
  /** id of a visible element that labels the group. */
  "aria-labelledby"?: string;
  /** Extra class(es) appended to the `ui-radio-group` root. */
  className?: string;
  /** Test hook forwarded to the group root. */
  "data-testid"?: string;
}

/** Props for the exported {@link RadioGroupItem}. */
export interface RadioGroupItemProps {
  /** The value this radio selects. */
  value: string;
  /** Disable this individual radio. */
  disabled?: boolean;
  /** Associates the radio with a `<label htmlFor>`. */
  id?: string;
  /** Accessible label (use when there is no associated visible `<label>`). */
  "aria-label"?: string;
  /** Test hook forwarded to the radio control. */
  "data-testid"?: string;
}

/**
 * A single token-styled Radix radio control (the circle + selected dot). Exposed
 * so callers using the `children` escape hatch can render options that match the
 * primitive's styling inside a bespoke layout. Must be a descendant of a
 * {@link RadioGroup}.
 */
export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  RadioGroupItemProps
>(function RadioGroupItem({ value, disabled, id, ...rest }, ref) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className="ui-radio__control"
      value={value}
      disabled={disabled}
      id={id}
      {...rest}
    >
      <RadioGroupPrimitive.Indicator className="ui-radio__indicator" />
    </RadioGroupPrimitive.Item>
  );
});

/**
 * The single shared radio-group primitive. Compose from this instead of a set of
 * native `<input type="radio">` so keyboard roving, focus ring, group labeling,
 * and disabled styling stay consistent app-wide.
 */
export function RadioGroup({
  value,
  onValueChange,
  options,
  children,
  disabled,
  orientation = "vertical",
  name,
  className,
  ...rest
}: RadioGroupProps): React.ReactElement {
  const rootClass = className ? `ui-radio-group ${className}` : "ui-radio-group";

  return (
    <RadioGroupPrimitive.Root
      className={rootClass}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      orientation={orientation}
      name={name}
      aria-label={rest["aria-label"]}
      aria-labelledby={rest["aria-labelledby"]}
      data-testid={rest["data-testid"]}
    >
      {children ??
        options?.map((opt) => (
          <label key={opt.value} className="ui-radio">
            <RadioGroupItem
              value={opt.value}
              disabled={opt.disabled}
              aria-label={typeof opt.label === "string" ? opt.label : undefined}
              data-testid={opt["data-testid"]}
            />
            <span className="ui-radio__label">{opt.label}</span>
          </label>
        ))}
    </RadioGroupPrimitive.Root>
  );
}
