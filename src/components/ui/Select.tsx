import React from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { useModalPortalContainer } from "./Modal";
import "./ui.css";

/** A single option for the simple {@link Select} API. */
export interface SelectOption {
  /** The value submitted when this option is chosen. */
  value: string;
  /** The human-readable label shown in the trigger and list. */
  label: string;
  /** Disable this individual option. */
  disabled?: boolean;
}

/**
 * Props for the shared {@link Select} primitive — a token-styled skin over
 * `@radix-ui/react-select`. Keyboard navigation, typeahead, and portalling come
 * from Radix.
 *
 * The common case is the declarative `options` API. For richer items (icons,
 * groups) pass `children` instead, composed from the exported {@link SelectItem},
 * {@link SelectGroup}, {@link SelectSeparator} and {@link SelectLabel} — callers
 * never import `@radix-ui/react-select` directly (UISF2-009).
 */
export interface SelectProps {
  /** Controlled selected value. */
  value: string | undefined;
  /** Called with the newly selected value. */
  onChange: (value: string) => void;
  /** Declarative option list. Ignored when `children` is provided. */
  options?: SelectOption[];
  /** Custom item tree; overrides `options` for full control. */
  children?: React.ReactNode;
  /** Placeholder shown when no value is selected. */
  placeholder?: string;
  /** Disable the whole control. */
  disabled?: boolean;
  /** `id` of the trigger, so an external `<label htmlFor>` can point at it. */
  id?: string;
  /** Accessible label for the trigger. */
  "aria-label"?: string;
  /** Space-separated ids of elements describing the control (e.g. an error message). */
  "aria-describedby"?: string;
  /** Marks the control invalid for assistive tech when validation fails. */
  "aria-invalid"?: boolean;
  /** Test hook forwarded to the trigger. */
  "data-testid"?: string;
}

/** Props for the exported {@link SelectItem}. */
export interface SelectItemProps extends Omit<
  React.ComponentPropsWithoutRef<typeof RadixSelect.Item>,
  "value"
> {
  value: string;
  disabled?: boolean;
  children: React.ReactNode;
}

/**
 * A token-styled Radix Select item. Exposed so callers using the `children`
 * escape hatch can render options that match the primitive's styling.
 *
 * Forwards its ref and any extra props to the underlying item so it can be used
 * as the `asChild` trigger of another primitive — e.g. wrapping it in a
 * {@link Tooltip} to show a hover preview for the option.
 */
export const SelectItem = React.forwardRef<
  React.ElementRef<typeof RadixSelect.Item>,
  SelectItemProps
>(function SelectItem({ value, disabled, children, ...rest }, ref) {
  return (
    <RadixSelect.Item
      ref={ref}
      className="ui-select__item"
      value={value}
      disabled={disabled}
      data-value={value}
      {...rest}
    >
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
      <RadixSelect.ItemIndicator className="ui-select__item-indicator">
        <Check width={14} height={14} aria-hidden="true" />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
});

/** Props for the exported {@link SelectGroup}. */
export type SelectGroupProps = React.ComponentPropsWithoutRef<typeof RadixSelect.Group>;

/**
 * Groups related {@link SelectItem}s (e.g. a "Plugins" section) for the
 * `children` mode. Pair with {@link SelectLabel} for an accessible heading.
 */
export const SelectGroup = React.forwardRef<
  React.ElementRef<typeof RadixSelect.Group>,
  SelectGroupProps
>(function SelectGroup({ className, ...rest }, ref) {
  return <RadixSelect.Group ref={ref} className={cx("ui-select__group", className)} {...rest} />;
});

/** Props for the exported {@link SelectSeparator}. */
export type SelectSeparatorProps = React.ComponentPropsWithoutRef<typeof RadixSelect.Separator>;

/** A token-styled divider between option groups in the `children` mode. */
export const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof RadixSelect.Separator>,
  SelectSeparatorProps
>(function SelectSeparator({ className, ...rest }, ref) {
  return (
    <RadixSelect.Separator ref={ref} className={cx("ui-select__separator", className)} {...rest} />
  );
});

/** Props for the exported {@link SelectLabel}. */
export type SelectLabelProps = React.ComponentPropsWithoutRef<typeof RadixSelect.Label>;

/** A token-styled, non-selectable group heading inside a {@link SelectGroup}. */
export const SelectLabel = React.forwardRef<
  React.ElementRef<typeof RadixSelect.Label>,
  SelectLabelProps
>(function SelectLabel({ className, ...rest }, ref) {
  return (
    <RadixSelect.Label ref={ref} className={cx("ui-select__group-label", className)} {...rest} />
  );
});

/** Joins a base class with an optional caller class. */
function cx(base: string, extra: string | undefined): string {
  return extra ? `${base} ${extra}` : base;
}

/**
 * The single shared select primitive. Compose from this instead of a native
 * `<select>` or a bespoke dropdown so styling and keyboard behavior stay
 * consistent app-wide.
 */
export function Select({
  value,
  onChange,
  options,
  children,
  placeholder,
  disabled,
  id,
  ...rest
}: SelectProps): React.ReactElement {
  const testid = rest["data-testid"];
  // Portal into the enclosing Modal's content (if any) so the listbox stays
  // clickable inside a dialog; `null` falls back to Radix's default body (#1868).
  const portalContainer = useModalPortalContainer();

  return (
    <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RadixSelect.Trigger
        className="ui-select__trigger"
        id={id}
        aria-label={rest["aria-label"]}
        aria-describedby={rest["aria-describedby"]}
        aria-invalid={rest["aria-invalid"] || undefined}
        data-testid={testid}
        data-value={value ?? ""}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="ui-select__icon">
          <ChevronDown width={14} height={14} aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal container={portalContainer}>
        <RadixSelect.Content className="ui-select__content" position="popper" sideOffset={4}>
          <RadixSelect.Viewport>
            {children ??
              options?.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
                  {opt.label}
                </SelectItem>
              ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
