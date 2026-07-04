import React, { forwardRef } from "react";
import "./ui.css";

/** Visual variant of the button. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Control size. `md` (default) is 32px tall; `sm` is 28px. */
export type ButtonSize = "sm" | "md";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "ui-btn--primary",
  secondary: "ui-btn--secondary",
  ghost: "ui-btn--ghost",
  danger: "ui-btn--danger",
};

/**
 * Props for the shared {@link Button} primitive. Extends the native button
 * attributes, so any standard prop (`type`, `aria-*`, `form`, …) works.
 *
 * Phase 3 will extend `onClick` to optionally return a `Promise<void>` and drive
 * an internal idle → pending → success/error lifecycle. The click path here is
 * intentionally left as the plain native handler so that seam stays clean.
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. Defaults to `primary`. */
  variant?: ButtonVariant;
  /** Control height. Defaults to `md` (32px). */
  size?: ButtonSize;
  /** Stretch the button to fill the width of its container. */
  fullWidth?: boolean;
  /** Optional leading icon rendered before the label (typically a lucide icon). */
  icon?: React.ReactNode;
  /** Test hook forwarded to the DOM node. */
  "data-testid"?: string;
}

/**
 * The single shared button primitive. Every action button in the app should
 * compose from this rather than hand-rolling a `__btn` class. All colors,
 * radii, spacing, and focus rings come from design tokens, so a theme swap
 * recolors it automatically. Primary text uses `--text-on-accent` (never a
 * hardcoded white, which breaks the light theme).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", fullWidth = false, icon, type, className, children, ...rest },
  ref
) {
  const classes = [
    "ui-btn",
    VARIANT_CLASS[variant],
    size === "sm" ? "ui-btn--sm" : "",
    fullWidth ? "ui-btn--full" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button ref={ref} type={type ?? "button"} className={classes} {...rest}>
      {icon ? <span className="ui-btn__icon">{icon}</span> : null}
      {children}
    </button>
  );
});
