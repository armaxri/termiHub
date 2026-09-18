import React, { forwardRef } from "react";
import "./ui.css";

/**
 * Props for the shared {@link ColorInput} primitive. Extends the native input
 * attributes (minus `type`, which is fixed to `color`), so `value`, `onChange`,
 * `aria-label`, `data-testid`, etc. all work as on a native color input.
 */
export type ColorInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/**
 * The shared native color-swatch primitive: an `<input type="color">` with the
 * standard token-styled swatch skin (fixed square size, subtle border, rounded
 * corners, pointer cursor). Use it wherever a color picker swatch is needed —
 * e.g. the theme editor and the custom highlight-rule editor — instead of
 * hand-rolling `<input type="color">` with duplicated swatch CSS.
 *
 * Any extra `className` is merged after the base `ui-color-input` class, so a
 * call site can still add layout tweaks (e.g. `flex: 0 0 auto`).
 */
export const ColorInput = forwardRef<HTMLInputElement, ColorInputProps>(function ColorInput(
  { className, ...rest },
  ref
) {
  const classes = ["ui-color-input", className ?? ""].filter(Boolean).join(" ");
  return <input ref={ref} type="color" className={classes} {...rest} />;
});
