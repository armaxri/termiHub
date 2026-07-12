import React, { forwardRef } from "react";
import "./ui.css";

/**
 * Props for the shared {@link Input} primitive. Extends the native input
 * attributes, so any standard prop (`value`, `placeholder`, `onChange`, `type`,
 * …) works.
 */
/** Control size. `md` (default) is the standard 32px field; `sm` is a compact
 * bordered field for dense rows (e.g. inline file-browser editors). */
export type InputSize = "sm" | "md";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Render the error state (red border) and set `aria-invalid`. */
  error?: boolean;
  /**
   * Drop the border, background, and fixed height so the input inherits the
   * surrounding container's styling. Use for borderless inline editing (e.g. a
   * rename input inside a pill chip) where the standard bordered skin would
   * break the layout. Focus/keyboard behavior is unchanged.
   */
  inline?: boolean;
  /**
   * Control height. Defaults to `md` (the standard field). Use `sm` for the
   * compact bordered variant in dense rows such as the inline file-browser
   * New File / New Folder / rename editors.
   */
  size?: InputSize;
  /** Test hook forwarded to the DOM node. */
  "data-testid"?: string;
}

/**
 * The single shared text-input primitive. Token-styled (`--bg-input`,
 * `--border-primary`, focus ring via `--shadow-focus`); the `error` prop flips
 * the border to `--color-error`. Compose it inside a {@link Field} to get a
 * label and inline validation message.
 *
 * The `inline` variant drops the border/background/height so the input blends
 * into a surrounding element (e.g. an inline rename affordance), inheriting its
 * font and color while keeping the primitive's focus/keyboard behavior. The
 * `sm` size keeps the bordered skin but shrinks it for dense rows.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { error = false, inline = false, size = "md", type, className, ...rest },
  ref
) {
  const classes = [
    "ui-input",
    inline ? "ui-input--inline" : "",
    size === "sm" ? "ui-input--sm" : "",
    error ? "ui-input--error" : "",
    className ?? "",
  ]
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
