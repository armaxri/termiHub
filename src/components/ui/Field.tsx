import React, { useId } from "react";
import { AlertCircle } from "lucide-react";
import "./ui.css";

/** Visual field style. `"settings"` renders the compact settings-panel field
 * scaffold (uppercase label, `settings-form__*` classes); `"default"` renders
 * the standard form field (`ui-field__*` classes). */
export type FieldVariant = "default" | "settings";

/** Visual variant applied to the field's hint text. */
export type FieldHintVariant = "default" | "warning";

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
  /** Visual field style. Defaults to `"default"`. */
  variant?: FieldVariant;
  /** The control element (e.g. an {@link Input} or {@link Select}). */
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
  { field: string; label: string; hint: string; hintWarning: string; errorTestId: string }
> = {
  default: {
    field: "ui-field",
    label: "ui-field__label",
    hint: "ui-field__hint",
    hintWarning: "ui-field__hint--warning",
    errorTestId: "field-error",
  },
  settings: {
    field: "settings-form__field",
    label: "settings-form__label",
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
  variant = "default",
  children,
  className,
  ...rest
}: FieldProps): React.ReactElement {
  const generatedId = useId();
  const classes = VARIANT_CLASSES[variant];
  const hasError = error !== undefined && error !== null && error !== false && error !== "";
  const errorId = htmlFor ? `${htmlFor}-error` : generatedId;
  const hasHint = hint !== undefined && hint !== null && hint !== false;

  // Propagate label association and error state onto the wrapped control. Only
  // clone when a prop actually changes, so callers that need nothing injected
  // keep their element untouched.
  let control = children;
  if (React.isValidElement(children)) {
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

  const wrapperClasses = [classes.field, className ?? ""].filter(Boolean).join(" ");
  const hintClasses = [classes.hint, hintVariant === "warning" ? classes.hintWarning : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapperClasses} {...rest}>
      {htmlFor ? (
        <label className={classes.label} htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className={classes.label}>{label}</span>
      )}
      {control}
      {hasHint ? <span className={hintClasses}>{hint}</span> : null}
      {hasError ? (
        <span className="ui-field__msg" id={errorId} role="alert" data-testid={classes.errorTestId}>
          <AlertCircle className="ui-field__msg-icon" aria-hidden="true" />
          {error}
        </span>
      ) : null}
    </div>
  );
}
