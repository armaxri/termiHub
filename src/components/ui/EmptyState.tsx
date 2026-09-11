import React from "react";
import { Spinner } from "./Spinner";
import "./ui.css";

/**
 * Visual density of an {@link EmptyState}:
 *  - `inline` — a compact, left-aligned muted line for list/sidebar/dialog
 *    empties (the most common case).
 *  - `panel`  — a centred, dashed-border box for "nothing configured yet"
 *    settings panels.
 *  - `card`   — a large centred call-to-action card (icon badge + title +
 *    description + actions), e.g. an empty window.
 */
export type EmptyStateVariant = "inline" | "panel" | "card";

/**
 * Props for the shared {@link EmptyState} primitive — the single home for
 * "empty list", "no results", and inline "loading…" placeholders.
 */
export interface EmptyStateProps {
  /** Primary message. When {@link loading} is set and omitted, defaults to `"Loading…"`. */
  title?: React.ReactNode;
  /** Optional secondary line under the title. */
  description?: React.ReactNode;
  /** Optional leading icon (a lucide element). Rendered in an icon badge in the `card` variant. */
  icon?: React.ReactNode;
  /** Optional action slot (typically a `Button`), shown below the text. */
  action?: React.ReactNode;
  /** Render a {@link Spinner} in place of the icon and treat this as a loading placeholder. */
  loading?: boolean;
  /** Visual density. Defaults to `inline`. */
  variant?: EmptyStateVariant;
  /**
   * ARIA role for the wrapper. Defaults to `"status"` so the message is
   * announced when it appears (matches the existing hand-rolled empties). Pass
   * a different role or `undefined` to opt out.
   */
  role?: string;
  /** Extra class for layout tweaks at the call site. */
  className?: string;
  /** Test hook forwarded to the wrapper element. */
  "data-testid"?: string;
}

/**
 * The single shared empty-/loading-state primitive. Replaces the per-component
 * `__empty` markup + class scattered across lists, panels, and dialogs with one
 * token-driven, consistently-structured component.
 *
 * All three variants share the same slots (icon/spinner, title, description,
 * action); the `variant` only changes density and alignment so a migrated site
 * stays visually close to what it had.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  loading = false,
  variant = "inline",
  role = "status",
  className,
  "data-testid": dataTestId,
}: EmptyStateProps): React.ReactElement {
  const resolvedTitle = title ?? (loading ? "Loading…" : null);
  const classes = ["ui-empty", `ui-empty--${variant}`, className ?? ""].filter(Boolean).join(" ");

  const leading = loading ? (
    <Spinner size={variant === "card" ? "lg" : "sm"} label={null} className="ui-empty__spinner" />
  ) : (
    icon
  );

  return (
    <div className={classes} role={role} data-testid={dataTestId}>
      {leading != null && <div className="ui-empty__icon">{leading}</div>}
      {resolvedTitle != null && <p className="ui-empty__title">{resolvedTitle}</p>}
      {description != null && <p className="ui-empty__description">{description}</p>}
      {action != null && <div className="ui-empty__actions">{action}</div>}
    </div>
  );
}
