import React, { useId } from "react";
import { AlertCircle } from "lucide-react";
import "./ui.css";

/** Visual field style. `"settings"` renders the compact settings-panel field
 * scaffold (uppercase label, `settings-form__*` classes); `"default"` renders
 * the standard form field (`ui-field__*` classes). */
export type FieldVariant = "default" | "settings";

/** Visual variant applied to the field's hint text. */
export type FieldHintVariant = "default" | "warning";

/** Field layout. `"stack"` renders label above control (the default);
 * `"checkbox"` renders a single-row `<label>` with the control first and the
 * label text beside it, so clicking the text toggles the control. */
export type FieldLayout = "stack" | "checkbox";

/** Where the hint renders: below the control (default) or directly under the
 * label, e.g. for a list whose description belongs above its rows. */
export type FieldHintPosition = "afterControl" | "afterLabel";

/**
 * Props for the presentational {@link Field} wrapper: a label, a control slot,
 * and an optional inline hint and/or error message.
 *
 * It is react-hook-form-friendly but not coupled to it — pass a resolved
 * `error?: string` (e.g. `formState.errors.host?.message`) and wire the control
 * at the call site.
 *
 * The label is associated with its control in one of two ways:
 * - When `htmlFor` is set, a real `<label htmlFor>` points at the control's `id`
 *   and the error node carries `id="{htmlFor}-error"` for `aria-describedby`.
 * - When `htmlFor` is omitted (controls without a stable `id`), the label renders
 *   as a `<span>` and the control's accessible name is derived from `label` via
 *   `aria-label`, with a generated id linking any error message.
 */
export interface FieldProps {
  /** Label text shown above the control. */
  label: string;
  /**
   * `id` of the control this label points at (label `htmlFor`). When omitted,
   * the label renders as a `<span>` and the control's `aria-label` is derived
   * from {@link FieldProps.label} unless the control already declares one.
   */
  htmlFor?: string;
  /** Resolved validation message. When set, the error state renders. */
  error?: React.ReactNode;
  /** Optional explanatory hint rendered below the control. */
  hint?: React.ReactNode;
  /** Hint styling — `"warning"` colors the hint as a caution. Defaults to `"default"`. */
  hintVariant?: FieldHintVariant;
  /** Hint placement. Defaults to `"afterControl"`. */
  hintPosition?: FieldHintPosition;
  /** Visual field style. Defaults to `"default"`. */
  variant?: FieldVariant;
  /** Field layout. Defaults to `"stack"`. */
  layout?: FieldLayout;
  /**
   * Marks the field as required with a decorative (`aria-hidden`) asterisk after
   * the label text. Set `aria-required` on the control for assistive tech.
   */
  required?: boolean;
  /**
   * Interactive affordance rendered *beside* the label (not inside it), e.g. a
   * "?" help button or an "Add" action. When set, the label and accessory share
   * a label row.
   */
  labelAccessory?: React.ReactNode;
  /** Decorative icon rendered before the label text. */
  labelIcon?: React.ReactNode;
  /** Extra class names for the label element. */
  labelClassName?: string;
  /**
   * Overrides the error message id (defaults to `{htmlFor}-error`, or a
   * generated id). Use when the control already points its `aria-describedby`
   * at a known id.
   */
  errorId?: string;
  /** Overrides the error message `data-testid` (defaults per variant). */
  errorTestId?: string;
  /**
   * The control element (e.g. an {@link Input} or {@link Select}). A single
   * element receives the injected label/error wiring. A fragment is treated as
   * a composite control that wires its own accessibility and is left untouched.
   */
  children: React.ReactNode;
  /** Extra class names for the wrapper. */
  className?: string;
  /** Test hook forwarded to the wrapper node. */
  "data-testid"?: string;
}

/** Props the {@link Field} wrapper injects onto its single control child. */
interface InjectedControlProps {
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** Per-variant class families and error test hook. */
const VARIANT_CLASSES: Record<
  FieldVariant,
  {
    field: string;
    checkbox: string;
    label: string;
    labelRow: string;
    required: string;
    hint: string;
    hintWarning: string;
    errorTestId: string;
  }
> = {
  default: {
    field: "ui-field",
    checkbox: "ui-field--checkbox",
    label: "ui-field__label",
    labelRow: "ui-field__label-row",
    required: "ui-field__required",
    hint: "ui-field__hint",
    hintWarning: "ui-field__hint--warning",
    errorTestId: "field-error",
  },
  settings: {
    field: "settings-form__field",
    checkbox: "settings-form__field--checkbox",
    label: "settings-form__label",
    labelRow: "settings-form__label-row",
    required: "settings-form__required",
    hint: "settings-form__hint",
    hintWarning: "settings-form__hint--warning",
    errorTestId: "settings-field-error",
  },
};

/**
 * Merge an existing `aria-describedby` (which the child may already carry) with
 * an extra id, de-duplicating and dropping empties. Returns `undefined` when
 * there is nothing to describe, so the attribute is omitted entirely.
 */
function mergeDescribedBy(existing: unknown, extra?: string): string | undefined {
  const ids = new Set<string>();
  if (typeof existing === "string") {
    for (const id of existing.split(/\s+/)) if (id) ids.add(id);
  }
  if (extra) ids.add(extra);
  return ids.size > 0 ? Array.from(ids).join(" ") : undefined;
}

/**
 * The single shared field wrapper — one consistent label + inline hint/error
 * affordance across every form in the app, in both the default form style and
 * the compact settings-panel style (`variant="settings"`). Purely
 * presentational: it renders structure and wires accessibility ids, leaving
 * form state to the caller.
 *
 * When an `error` is present it programmatically links the message to the
 * control it wraps: the single child element is cloned with
 * `aria-describedby` (merged with any the child already sets) and `aria-invalid`,
 * so screen readers announce the invalid state and read the message on focus —
 * without every call site having to wire it by hand.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  hintVariant = "default",
  hintPosition = "afterControl",
  variant = "default",
  layout = "stack",
  required = false,
  labelAccessory,
  labelIcon,
  labelClassName,
  errorId: errorIdOverride,
  errorTestId,
  children,
  className,
  ...rest
}: FieldProps): React.ReactElement {
  const generatedId = useId();
  const classes = VARIANT_CLASSES[variant];
  const hasError = error !== undefined && error !== null && error !== false && error !== "";
  const errorId = errorIdOverride ?? (htmlFor ? `${htmlFor}-error` : generatedId);
  const hasHint = hint !== undefined && hint !== null && hint !== false;

  // Propagate label association and error state onto the wrapped control. Only
  // clone when a prop actually changes, so callers that need nothing injected
  // keep their element untouched.
  let control = children;
  if (React.isValidElement(children) && children.type !== React.Fragment) {
    const childProps = children.props as InjectedControlProps;
    const injected: InjectedControlProps = {};
    // Without an explicit `htmlFor` there is no `<label for>`, so derive the
    // control's accessible name from the label unless it already has one.
    if (!htmlFor && childProps["aria-label"] === undefined) {
      injected["aria-label"] = label;
    }
    if (hasError) {
      injected["aria-invalid"] = true;
      injected["aria-describedby"] = mergeDescribedBy(childProps["aria-describedby"], errorId);
    }
    if (Object.keys(injected).length > 0) {
      control = React.cloneElement(children as React.ReactElement<InjectedControlProps>, injected);
    }
  }

  const isCheckbox = layout === "checkbox";
  const wrapperClasses = [classes.field, isCheckbox ? classes.checkbox : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const hintClasses = [classes.hint, hintVariant === "warning" ? classes.hintWarning : ""]
    .filter(Boolean)
    .join(" ");
  const labelClasses = [classes.label, labelClassName ?? ""].filter(Boolean).join(" ");

  const labelContent = (
    <>
      {labelIcon}
      {label}
      {required ? (
        <span className={classes.required} aria-hidden="true">
          {" "}
          *
        </span>
      ) : null}
    </>
  );

  const hintNode = hasHint ? <span className={hintClasses}>{hint}</span> : null;
  const errorNode = hasError ? (
    <span
      className="ui-field__msg"
      id={errorId}
      role="alert"
      data-testid={errorTestId ?? classes.errorTestId}
    >
      <AlertCircle className="ui-field__msg-icon" aria-hidden="true" />
      {error}
    </span>
  ) : null;

  if (isCheckbox) {
    // The wrapper itself is the `<label>`, so clicking the text toggles the
    // control; the visible text is a span to avoid nesting labels.
    return (
      <label className={wrapperClasses} htmlFor={htmlFor} {...rest}>
        {control}
        <span className={labelClasses}>{labelContent}</span>
        {labelAccessory}
        {hintNode}
        {errorNode}
      </label>
    );
  }

  const labelNode = htmlFor ? (
    <label className={labelClasses} htmlFor={htmlFor}>
      {labelContent}
    </label>
  ) : (
    <span className={labelClasses}>{labelContent}</span>
  );

  return (
    <div className={wrapperClasses} {...rest}>
      {labelAccessory !== undefined && labelAccessory !== null && labelAccessory !== false ? (
        <div className={classes.labelRow}>
          {labelNode}
          {labelAccessory}
        </div>
      ) : (
        labelNode
      )}
      {hintPosition === "afterLabel" ? hintNode : null}
      {control}
      {hintPosition === "afterControl" ? hintNode : null}
      {errorNode}
    </div>
  );
}
