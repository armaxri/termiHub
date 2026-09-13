import React from "react";
import "./ui.css";

/**
 * Semantic tone for a {@link StatusDot}, each mapped to a design token so every
 * surface renders status colour from one source of truth (UISF-003).
 *
 * `notice` is the brighter amber reserved for update/attention cues
 * (`--color-notice`), distinct from the softer `warning` (`--color-warning`).
 */
export type StatusTone = "neutral" | "success" | "warning" | "error" | "notice";

/** Diameter variant for a {@link StatusDot}: `sm` 7px · `md` 8px. */
export type StatusDotSize = "sm" | "md";

/** Props for the shared {@link StatusDot} primitive. */
export interface StatusDotProps {
  /** Colour tone of the dot. */
  tone: StatusTone;
  /** Diameter variant. Defaults to `md` (8px). */
  size?: StatusDotSize;
  /**
   * Accessible name describing the status the dot conveys (e.g. "Running",
   * "Update available"). Rendered as the dot's `aria-label` (with `role="img"`)
   * so screen-reader and colourblind users perceive the state without relying
   * on colour alone (WCAG 1.4.1 / 1.1.1). Omit for a purely decorative dot that
   * sits beside text already conveying the same state.
   */
  label?: string;
  /** Extra class for layout tweaks (margin) at the call site. */
  className?: string;
  /** Test hook forwarded to the dot element. */
  testId?: string;
}

/**
 * The single small coloured status dot for the app: sidebars, the status bar,
 * transfer/plugin rows, and update indicators all render this instead of a
 * per-component `__dot` / `__status` span with copy-pasted colour modifiers
 * (UISF-003). Colours come from design tokens via the `--tone` modifier, so the
 * tone→token map is the one source of status colour.
 *
 * When `label` is supplied the dot becomes an `img`-role graphic named by that
 * label, so its meaning survives without colour (WCAG 1.4.1 / 1.1.1).
 */
export function StatusDot({
  tone,
  size = "md",
  label,
  className,
  testId,
}: StatusDotProps): React.ReactElement {
  const classes = [
    "status-dot",
    `status-dot--${tone}`,
    size === "sm" ? "status-dot--sm" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      role={label ? "img" : undefined}
      aria-label={label}
      data-testid={testId}
    />
  );
}
