import React, { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "./Toast";
import "./ui.css";

/** Visual variant of the button. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Control size. `md` (default) is 32px tall; `sm` is 28px. */
export type ButtonSize = "sm" | "md";

/** Internal lifecycle state for an async click. */
type AsyncState = "idle" | "pending" | "success";

/** How long the success affordance lingers before returning to idle (ms). */
const SUCCESS_MS = 1200;

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
 * `onClick` may return a `Promise<void>`. When it does, the Button drives an
 * idle → pending → success/error lifecycle (see {@link Button}). A plain sync
 * `onClick` behaves exactly as a native button — no lifecycle, no spinner.
 */
export interface ButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick"
> {
  /** Visual style. Defaults to `primary`. */
  variant?: ButtonVariant;
  /** Control height. Defaults to `md` (32px). */
  size?: ButtonSize;
  /** Stretch the button to fill the width of its container. */
  fullWidth?: boolean;
  /** Optional leading icon rendered before the label (typically a lucide icon). */
  icon?: React.ReactNode;
  /**
   * Click handler. Returning a `Promise<void>` opts into the async lifecycle:
   * the button disables + shows a spinner while pending, flashes success, then
   * returns to idle; a rejection returns to idle and surfaces a `toast.error`.
   */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  /**
   * Label shown while an async click is pending. Defaults to the normal
   * children (the label just gets a spinner beside it).
   */
  pendingLabel?: React.ReactNode;
  /**
   * Surface a `toast.error` when an async `onClick` rejects. Defaults to `true`.
   * Set `false` when the caller reports the error itself.
   */
  errorToast?: boolean;
  /** Test hook forwarded to the DOM node. */
  "data-testid"?: string;
}

/** True when a value is a thenable (an async `onClick` return). */
function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown })?.then === "function";
}

/**
 * The single shared button primitive. Every action button in the app should
 * compose from this rather than hand-rolling a `__btn` class. All colors,
 * radii, spacing, and focus rings come from design tokens, so a theme swap
 * recolors it automatically. Primary text uses `--text-on-accent` (never a
 * hardcoded white, which breaks the light theme).
 *
 * Async lifecycle (opt-in via an async `onClick`): idle → pending (disabled +
 * spinner) → success (brief) → idle, or → idle on rejection with a default
 * `toast.error`. Fully backward compatible: a sync `onClick` runs unchanged and
 * never enters the lifecycle.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    fullWidth = false,
    icon,
    type,
    className,
    children,
    onClick,
    pendingLabel,
    errorToast = true,
    disabled,
    ...rest
  },
  ref
) {
  const [asyncState, setAsyncState] = useState<AsyncState>("idle");
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  }, []);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!onClick || asyncState === "pending") return;

      const result = onClick(event);
      if (!isPromise(result)) return; // sync path — behaves exactly as before

      setAsyncState("pending");
      result.then(
        () => {
          if (!mounted.current) return;
          setAsyncState("success");
          successTimer.current = setTimeout(() => {
            if (mounted.current) setAsyncState("idle");
          }, SUCCESS_MS);
        },
        (error: unknown) => {
          if (mounted.current) setAsyncState("idle");
          if (errorToast) {
            const msg = error instanceof Error ? error.message : String(error);
            toast.error(msg);
          }
        }
      );
    },
    [onClick, asyncState, errorToast]
  );

  const pending = asyncState === "pending";
  const success = asyncState === "success";

  const classes = [
    "ui-btn",
    VARIANT_CLASS[variant],
    size === "sm" ? "ui-btn--sm" : "",
    fullWidth ? "ui-btn--full" : "",
    pending ? "ui-btn--pending" : "",
    success ? "ui-btn--success" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes}
      onClick={handleClick}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? (
        <span className="ui-btn__spinner" aria-hidden />
      ) : icon ? (
        <span className="ui-btn__icon">{icon}</span>
      ) : null}
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
});
