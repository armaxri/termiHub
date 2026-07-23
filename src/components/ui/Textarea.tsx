import React, { forwardRef } from "react";
import "./ui.css";

/**
 * Props for the shared {@link Textarea} primitive. Extends the native textarea
 * attributes, so any standard prop (`value`, `placeholder`, `onChange`, `rows`,
 * …) works.
 */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Render the error state (red border) and set `aria-invalid`. */
  error?: boolean;
  /** Test hook forwarded to the DOM node. */
  "data-testid"?: string;
}

/**
 * The shared multi-line text-input primitive — the textarea analog of
 * {@link Input}. Token-styled (`--bg-input`, `--border-primary`, focus ring via
 * `--shadow-focus`); the `error` prop flips the border to `--color-error`.
 * Compose it inside a {@link Field} to get a label and inline validation
 * message. Used for multi-line bodies such as a workflow `run-script` step.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { error = false, rows = 4, className, ...rest },
  ref
) {
  const classes = ["ui-textarea", error ? "ui-textarea--error" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <textarea
      ref={ref}
      rows={rows}
      className={classes}
      aria-invalid={error || undefined}
      {...rest}
    />
  );
});
