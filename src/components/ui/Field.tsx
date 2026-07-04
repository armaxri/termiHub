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

/**
 * The single shared field wrapper — one consistent label + inline error
 * affordance across every form in the app. Purely presentational: it renders
 * structure and wires accessibility ids, leaving form state to the caller.
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

  return (
    <div className={classes} {...rest}>
      <label className="ui-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="ui-field__msg" id={errorId} role="alert" data-testid="field-error">
          <AlertCircle className="ui-field__msg-icon" aria-hidden="true" />
          {error}
        </span>
      ) : null}
    </div>
  );
}
