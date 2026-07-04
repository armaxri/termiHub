import React, { forwardRef } from "react";
import "./ui.css";

/**
 * Props for the shared {@link Input} primitive. Extends the native input
 * attributes, so any standard prop (`value`, `placeholder`, `onChange`, `type`,
 * …) works.
 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Render the error state (red border) and set `aria-invalid`. */
  error?: boolean;
  /** Test hook forwarded to the DOM node. */
  "data-testid"?: string;
}

/**
 * The single shared text-input primitive. Token-styled (`--bg-input`,
 * `--border-primary`, focus ring via `--shadow-focus`); the `error` prop flips
 * the border to `--color-error`. Compose it inside a {@link Field} to get a
 * label and inline validation message.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { error = false, type, className, ...rest },
  ref
) {
  const classes = ["ui-input", error ? "ui-input--error" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <input
      ref={ref}
      type={type ?? "text"}
      className={classes}
      aria-invalid={error || undefined}
      {...rest}
    />
  );
});
