import React from "react";
import { Loader2 } from "lucide-react";
import "./ui.css";

/** Named spinner sizes. Map to a pixel diameter for the lucide icon. */
export type SpinnerSize = "xs" | "sm" | "md" | "lg";

/** Pixel diameter for each named {@link SpinnerSize}. */
const SIZE_PX: Record<SpinnerSize, number> = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 30,
};

/**
 * Props for the shared {@link Spinner} primitive — the single inline
 * "working…" indicator for the app.
 */
export interface SpinnerProps {
  /**
   * Size of the spinner: a named variant (`xs` 12px · `sm` 16px · `md` 20px ·
   * `lg` 30px) or an explicit pixel diameter for exact-fidelity call sites.
   * Defaults to `sm`.
   */
  size?: SpinnerSize | number;
  /**
   * Accessible label announced by assistive tech. Defaults to `"Loading…"`.
   * Pass `null` to render a purely decorative spinner (e.g. inside a control
   * that already announces its own busy state) — `role`/`aria-label` are then
   * omitted and the icon is hidden from the accessibility tree.
   */
  label?: string | null;
  /** Extra class for layout tweaks (margin, colour) at the call site. */
  className?: string;
  /** Test hook forwarded to the rendered element. */
  "data-testid"?: string;
}

/**
 * The single shared loading-spinner primitive: a token-driven, accessible skin
 * over lucide's `Loader2`. It owns the rotation (`th-spin`) and carries
 * `motion-essential-spinner`, so under `prefers-reduced-motion` it degrades to
 * a gentle opacity pulse instead of freezing into a "hung"-looking static icon.
 *
 * Use this instead of hand-rolling a `<Loader2 className="…__spinner">` plus a
 * per-component spin class. Where the spinner lives inside a button, prefer the
 * async `Button` state instead.
 */
export function Spinner({
  size = "sm",
  label = "Loading…",
  className,
  "data-testid": dataTestId,
}: SpinnerProps): React.ReactElement {
  const px = typeof size === "number" ? size : SIZE_PX[size];
  const classes = ["ui-spinner", "motion-essential-spinner", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <Loader2
      className={classes}
      size={px}
      role={label == null ? undefined : "status"}
      aria-label={label ?? undefined}
      aria-hidden={label == null ? true : undefined}
      data-testid={dataTestId}
    />
  );
}
