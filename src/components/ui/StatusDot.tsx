import React from "react";
import "./ui.css";

/**
 * Semantic tone for a {@link StatusDot}, each mapped to a design token so every
 * surface renders status colour from one source of truth (UISF-003).
 *
 * `notice` is the brighter amber reserved for update/attention cues
 * (`--color-notice`), distinct from the softer `warning` (`--color-warning`).
 *
 * The `connected` / `connecting` / `disconnected` tones are the dedicated
 * connection/run-state palette (`--state-*`), kept distinct from the semantic
 * `success` / `warning` / `error` tones so connection dots keep their exact
 * colours (UISF-003 follow-up). `disabled` is the muted "off" tone
 * (`--text-disabled`).
 */
export type StatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "error"
  | "notice"
  | "connected"
  | "connecting"
  | "disconnected"
  | "disabled";

/** Diameter variant for a {@link StatusDot}: `sm` 7px · `md` 8px · `lg` 9px. */
export type StatusDotSize = "sm" | "md" | "lg";

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
  /**
   * Pulse the dot to signal an in-flight transition (connecting / starting /
   * stopping). Disabled under `prefers-reduced-motion`.
   */
  pulse?: boolean;
  /**
   * Dim the dot (reduced opacity) for a muted/stopped state that keeps its tone
   * but reads as inactive (the persistent-session "stopped" dot).
   */
  dimmed?: boolean;
  /** Native tooltip text shown on hover (e.g. attached-tab list, state word). */
  title?: string;
  /**
   * Hide the dot from assistive technology (`aria-hidden`). Use when adjacent
   * text already conveys the same state, so the dot is purely decorative.
   */
  ariaHidden?: boolean;
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
  pulse = false,
  dimmed = false,
  title,
  ariaHidden,
  className,
  testId,
}: StatusDotProps): React.ReactElement {
  const classes = [
    "status-dot",
    `status-dot--${tone}`,
    size === "sm" ? "status-dot--sm" : "",
    size === "lg" ? "status-dot--lg" : "",
    pulse ? "status-dot--pulse" : "",
    dimmed ? "status-dot--dimmed" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={ariaHidden}
      title={title}
      data-testid={testId}
    />
  );
}
