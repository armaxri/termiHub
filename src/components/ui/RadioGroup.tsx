import React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Tooltip, TooltipLines } from "./Tooltip";
import "./ui.css";

/** A single option for the declarative {@link RadioGroup} API. */
export interface RadioGroupOption {
  /** The value submitted when this option is chosen. */
  value: string;
  /** The human-readable label shown next to the radio. */
  label: React.ReactNode;
  /**
   * Secondary text under the label. Only rendered by the `cards` variant, where
   * it is wired to the radio as its accessible description.
   */
  description?: React.ReactNode;
  /**
   * A longer explanation, one sentence or idea per line. Only rendered by the
   * `cards` variant: shown in a tooltip while the card is hovered or holds
   * keyboard focus (selected or not), and always part of the radio's accessible
   * description. Keep what the user needs at a glance in `description`; touch
   * users never see the tooltip. Needs a `TooltipProvider` above. Do not
   * combine with `title`: two tooltips would open.
   */
  help?: readonly string[];
  /** Disable this individual option. */
  disabled?: boolean;
  /** Native tooltip for the option (e.g. why it is disabled). */
  title?: string;
  /** Test hook forwarded to the option's radio control. */
  "data-testid"?: string;
}

/**
 * Visual skin of a {@link RadioGroup}:
 * - `default` — a small radio circle beside each label.
 * - `cards` — each option is a bordered card (label + optional description);
 *   the whole card is the radio, and the selected card gets the accent border
 *   plus an accent tint. A radio mark (circle, filled when selected) leads each
 *   card, so the choice is also shown by shape, not by colour alone (#5560).
 *   This is the one shared "pick one of N described options" selector
 *   (UISF2-002 / UI2-006).
 */
export type RadioGroupVariant = "default" | "cards";

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
  /** Visual skin; `cards` renders `options` as selectable cards. */
  variant?: RadioGroupVariant;
  /**
   * Where a card's help tooltip opens (default `top`). Beside the cards keeps
   * the options being compared in view (#6036).
   */
  helpSide?: "top" | "right" | "bottom" | "left";
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
  /** Marks the group invalid (set by a wrapping `Field` with an error). */
  "aria-invalid"?: boolean;
  /** id of the text that describes the group (e.g. its error). */
  "aria-describedby"?: string;
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
 * The Radix radio a card's help tooltip is attached to. Two of the tooltip
 * trigger's injected props do not fit a radio:
 * - its `data-state` (open or closed) would replace the radio's `checked` /
 *   `unchecked`, and with it the selected style, so it is dropped;
 * - its `onClick` closes the tooltip. The arrow keys select through a synthetic
 *   click, so it only runs for a real pointer click (`detail` counts presses):
 *   a keyboard user keeps the help of the card they moved to.
 */
const RadioCardItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  RadioGroupPrimitive.RadioGroupItemProps & { "data-state"?: string }
>(function RadioCardItem({ "data-state": _tooltipState, onClick, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      {...props}
      onClick={(e) => {
        if (e.detail > 0) onClick?.(e);
      }}
    />
  );
});

/** Props for the internal card-option renderer. */
interface RadioCardProps {
  option: RadioGroupOption;
  /** Stable id prefix used to wire the label/description to the radio. */
  idPrefix: string;
  helpSide: "top" | "right" | "bottom" | "left";
}

/**
 * One option of the `cards` variant: the Radix radio itself is the card, so the
 * whole card is clickable, sits in the group's roving tab order, and exposes
 * `role="radio"` + `aria-checked`. The label names the radio and the
 * description (plus the help, when there is one) describes it, so screen
 * readers announce them separately.
 */
function RadioCard({ option, idPrefix, helpSide }: RadioCardProps): React.ReactElement {
  const labelId = `${idPrefix}-label`;
  const descId = `${idPrefix}-desc`;
  const helpId = `${idPrefix}-help`;
  const hasDescription = option.description !== undefined && option.description !== null;
  const help = option.help ?? [];
  const describedBy = [hasDescription && descId, help.length > 0 && helpId].filter(Boolean);
  const card = (
    <RadioCardItem
      className="ui-radio-card"
      value={option.value}
      disabled={option.disabled}
      title={option.title}
      aria-labelledby={labelId}
      aria-describedby={describedBy.length > 0 ? describedBy.join(" ") : undefined}
      data-testid={option["data-testid"]}
    >
      {/* Decorative: the card itself is the radio and carries aria-checked. */}
      <span className="ui-radio-card__mark" aria-hidden="true" />
      <span className="ui-radio-card__label" id={labelId}>
        {option.label}
      </span>
      {hasDescription && (
        <span className="ui-radio-card__desc" id={descId}>
          {option.description}
        </span>
      )}
    </RadioCardItem>
  );
  if (help.length === 0) return card;
  return (
    <>
      <Tooltip
        content={<TooltipLines lines={help} />}
        side={helpSide}
        data-testid={option["data-testid"] && `${option["data-testid"]}-help`}
      >
        {card}
      </Tooltip>
      {/* The help for assistive tech while no tooltip is open. `hidden` keeps it
          out of the layout and the reading order; aria-describedby still reads it. */}
      <span id={helpId} hidden>
        {help.join(" ")}
      </span>
    </>
  );
}

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
  variant = "default",
  helpSide = "top",
  name,
  className,
  ...rest
}: RadioGroupProps): React.ReactElement {
  const idBase = React.useId();
  const rootRef = React.useRef<HTMLDivElement>(null);
  // Focus follows the selection (#5630). A mouse click in WebKit (and any
  // synthetic click) selects a radio without focusing it, which left the
  // focus ring on the previous option while another showed as selected: two
  // emphasised options at once. Only moves focus that is already on a radio
  // in this group; never pulls focus in from elsewhere.
  React.useLayoutEffect(() => {
    const group = rootRef.current;
    const active = document.activeElement;
    if (!group || !(active instanceof HTMLElement) || !group.contains(active)) return;
    if (active.getAttribute("role") !== "radio" || active.dataset.state === "checked") return;
    group.querySelector<HTMLElement>('[role="radio"][data-state="checked"]')?.focus();
  }, [value]);
  const classes = ["ui-radio-group"];
  if (variant === "cards") classes.push("ui-radio-group--cards");
  if (className) classes.push(className);
  const rootClass = classes.join(" ");

  const renderOptions = (): React.ReactNode => {
    if (variant === "cards") {
      return options?.map((opt, i) => (
        <RadioCard
          key={opt.value}
          option={opt}
          idPrefix={`${idBase}-opt${i}`}
          helpSide={helpSide}
        />
      ));
    }
    return options?.map((opt) => (
      <label key={opt.value} className="ui-radio" title={opt.title}>
        <RadioGroupItem
          value={opt.value}
          disabled={opt.disabled}
          aria-label={typeof opt.label === "string" ? opt.label : undefined}
          data-testid={opt["data-testid"]}
        />
        <span className="ui-radio__label">{opt.label}</span>
      </label>
    ));
  };

  return (
    <RadioGroupPrimitive.Root
      ref={rootRef}
      className={rootClass}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      orientation={orientation}
      name={name}
      aria-label={rest["aria-label"]}
      aria-labelledby={rest["aria-labelledby"]}
      aria-invalid={rest["aria-invalid"] || undefined}
      aria-describedby={rest["aria-describedby"]}
      data-testid={rest["data-testid"]}
    >
      {children ?? renderOptions()}
    </RadioGroupPrimitive.Root>
  );
}
