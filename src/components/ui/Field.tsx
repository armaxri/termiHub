import React from "react";
import { AlertCircle } from "lucide-react";
import "./ui.css";

/**
 * Props for the presentational {@link Field} wrapper: a label, a control slot,
 * and an optional inline error message.
 *
 * It is react-hook-form-friendly but not coupled to it — pass a resolved
 * `error?: string` (e.g. `formState.errors.host?.message`) and wire the control
 * at the call site. The error node carries `id="{htmlFor}-error"` so the control
 * can reference it via `aria-describedby`.
 */
export interface FieldProps {
  /** Label text shown above the control. */
  label: string;
  /** `id` of the control this label points at (label `htmlFor`). */
  htmlFor: string;
  /** Resolved validation message. When set, the error state renders. */
  error?: string;
  /** The control element (e.g. an {@link Input} or {@link Select}). */
  children: React.ReactNode;
  /** Extra class names for the wrapper. */
  className?: string;
  /** Test hook forwarded to the wrapper node. */
  "data-testid"?: string;
}

/** Props the {@link Field} wrapper injects onto its single control child. */
interface InjectedControlProps {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

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
 * The single shared field wrapper — one consistent label + inline error
 * affordance across every form in the app. Purely presentational: it renders
 * structure and wires accessibility ids, leaving form state to the caller.
 *
 * When an `error` is present it programmatically links the message to the
 * control it wraps: the single child element is cloned with
 * `aria-describedby="{htmlFor}-error"` (merged with any the child already sets)
 * and `aria-invalid`, so screen readers announce the invalid state and read the
 * message on focus — without every call site having to wire it by hand.
 */
export function Field({
  label,
  htmlFor,
  error,
  children,
  className,
  ...rest
}: FieldProps): React.ReactElement {
  const errorId = `${htmlFor}-error`;
  const classes = ["ui-field", className ?? ""].filter(Boolean).join(" ");

  // Propagate the error association onto the wrapped control. Cloning keeps the
  // primitive presentational (no coupling to a specific input type) while
  // guaranteeing the field↔error link for all ~94 call sites at once.
  let control = children;
  if (React.isValidElement(children)) {
    const childProps = children.props as InjectedControlProps;
    const describedBy = mergeDescribedBy(
      childProps["aria-describedby"],
      error ? errorId : undefined
    );
    control = React.cloneElement(children as React.ReactElement<InjectedControlProps>, {
      "aria-describedby": describedBy,
      "aria-invalid": error ? true : childProps["aria-invalid"],
    });
  }

  return (
    <div className={classes} {...rest}>
      <label className="ui-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {control}
      {error ? (
        <span className="ui-field__msg" id={errorId} role="alert" data-testid="field-error">
          <AlertCircle className="ui-field__msg-icon" aria-hidden="true" />
          {error}
        </span>
      ) : null}
    </div>
  );
}
