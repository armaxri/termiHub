import React, { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { frontendLog } from "@/utils/frontendLog";
import { toast } from "./Toast";
import "./ui.css";

/** Visual variant of the button. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Control size. `md` (default) is 32px tall; `sm` is 28px; `xs` is 24px. */
export type ButtonSize = "xs" | "sm" | "md";

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

/** Size → modifier class. `md` is the base geometry, so it carries no modifier. */
const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: "ui-btn--xs",
  sm: "ui-btn--sm",
  md: "",
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
  /**
   * Render as a compact icon-only square (a dense action-row affordance — e.g.
   * a tunnel row or a network-monitor row). Drops the label padding and squares
   * the control to its height; the ghost skin (color/hover/radius/focus/pending/
   * success) still comes from the primitive. Icon-only buttons carry no visible
   * text, so an accessible name is required: pass `aria-label` (or `title`, or
   * wrap in a `Tooltip` and set `aria-label`). The primitive warns in the
   * LogViewer when one is missing.
   */
  iconOnly?: boolean;
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
 *
 * Native form-submit bridge (#1469): a `type="submit"` Button that has an
 * `onClick` locates its owning `<form>` (honouring the `form=` attribute, so it
 * works even when rendered outside the form — e.g. a Modal footer) and drives
 * the *same* async lifecycle on native submission. Pressing **Enter** in any
 * field therefore shows the identical pending affordance a **click** does,
 * through the single `disabled` gate — no per-form `preventDefault + action()`
 * wiring required. A submit Button *without* an `onClick` stays a plain native
 * submit control (its form's own `onSubmit` runs untouched).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    fullWidth = false,
    iconOnly = false,
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
  const isSubmit = type === "submit";

  // Internal handle to the DOM node, merged with the forwarded ref. The submit
  // bridge below needs it to reach the owning <form> and to re-dispatch a native
  // submission (Enter) through the button's own click.
  const innerRef = useRef<HTMLButtonElement | null>(null);
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = node;
    },
    [ref]
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  }, []);

  // Native form-submit bridge (#1469). Only a type="submit" Button with an
  // onClick owns the bridge: without an onClick it stays a plain native submit
  // control, and binding here would recurse via the node.click() below.
  //
  // Depend on onClick *presence*, not identity: the listener never reads the
  // handler (it only re-dispatches a click, which routes through the live
  // onClick prop), so re-attaching on every fresh inline-closure identity — i.e.
  // per keystroke in a controlled form — would be pure churn.
  const hasOnClick = !!onClick;
  useEffect(() => {
    if (!isSubmit || !hasOnClick) return;
    const node = innerRef.current;
    const form = node?.form;
    if (!node || !form) return;

    const handleFormSubmit = (event: Event) => {
      // Never let the SPA perform a real (navigating) submission. Route the
      // submit — including Enter from any field — through the button's own click
      // so it drives the SAME idle→pending→success lifecycle a click does,
      // gated by the button's disabled state (the single shared gate).
      event.preventDefault();
      if (node.disabled) return;
      node.click();
    };

    form.addEventListener("submit", handleFormSubmit);
    return () => form.removeEventListener("submit", handleFormSubmit);
  }, [isSubmit, hasOnClick]);

  // Icon-only buttons carry no visible label, so an accessible name is
  // mandatory. Surface a misuse (no aria-label / aria-labelledby / title) in the
  // LogViewer rather than shipping a silently unlabeled control (issue 1284).
  const ariaLabel = rest["aria-label"];
  const ariaLabelledby = rest["aria-labelledby"];
  const title = rest.title;
  useEffect(() => {
    if (iconOnly && !ariaLabel && !ariaLabelledby && !title) {
      frontendLog(
        "ui_button",
        "icon-only Button is missing an accessible name — add aria-label, aria-labelledby, or title"
      );
    }
  }, [iconOnly, ariaLabel, ariaLabelledby, title]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!onClick || asyncState === "pending") return;

      // A type="submit" Button drives its own lifecycle, so stop the native form
      // submission a real click would ALSO trigger — which, together with the
      // submit bridge, would run the action twice.
      if (isSubmit) event.preventDefault();

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
    [onClick, asyncState, errorToast, isSubmit]
  );

  const pending = asyncState === "pending";
  const success = asyncState === "success";

  const classes = [
    "ui-btn",
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    iconOnly ? "ui-btn--icon-only" : "",
    fullWidth ? "ui-btn--full" : "",
    pending ? "ui-btn--pending" : "",
    success ? "ui-btn--success" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={setRef}
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
