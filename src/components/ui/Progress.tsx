import React from "react";
import "./ui.css";

/**
 * Props for the shared {@link Progress} primitive — a thin, token-driven
 * horizontal progress bar.
 */
export interface ProgressProps {
  /** Current value (ignored when {@link indeterminate} or `max <= 0`). */
  value?: number;
  /** Maximum value. Defaults to `100`; `max <= 0` renders indeterminate. */
  max?: number;
  /** Force the indeterminate (unknown-total) animation. */
  indeterminate?: boolean;
  /** Accessible label describing what is progressing. */
  label?: string;
  /** Extra class for layout tweaks at the call site. */
  className?: string;
}

/**
 * The single shared progress-bar primitive. Renders a determinate fill
 * (`value / max`) or, when {@link indeterminate} is set (or `max <= 0`), an
 * animated indeterminate sweep. All colors/radii/motion come from design
 * tokens; the sweep is disabled under `prefers-reduced-motion`.
 *
 * Uses the ARIA `progressbar` role directly (a few-line accessible div beats
 * pulling in a dependency for a bar this simple); omitting `aria-valuenow` in
 * indeterminate mode is the correct signal for "unknown progress".
 */
export function Progress({
  value = 0,
  max = 100,
  indeterminate = false,
  label,
  className,
}: ProgressProps): React.ReactElement {
  const isIndeterminate = indeterminate || max <= 0;
  const clamped = Math.min(Math.max(value, 0), max);
  const pct = isIndeterminate ? 0 : (clamped / max) * 100;

  const classes = [
    "ui-progress",
    isIndeterminate ? "ui-progress--indeterminate" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      role="progressbar"
      aria-label={label}
      aria-valuemin={isIndeterminate ? undefined : 0}
      aria-valuemax={isIndeterminate ? undefined : max}
      aria-valuenow={isIndeterminate ? undefined : clamped}
    >
      <div
        className={
          isIndeterminate ? "ui-progress__fill motion-essential-spinner" : "ui-progress__fill"
        }
        style={isIndeterminate ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}
