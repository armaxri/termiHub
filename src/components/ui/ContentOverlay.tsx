import React from "react";
import "./ui.css";

/**
 * Props for the shared {@link ContentOverlay} primitive — the single skeleton for
 * "content-covering" connection-state screens (connecting, reconnecting, failed,
 * disconnected) rendered over a terminal or remote-desktop surface.
 */
export interface ContentOverlayProps {
  /**
   * The status icon element — a lucide icon or {@link Spinner}, already sized and
   * coloured by the caller (its `className` carries the per-state colour/spin, so
   * each surface keeps its own icon semantics). Rendered as the first child.
   */
  icon: React.ReactNode;
  /** Primary heading line (e.g. "Connecting…", "Connection failed"). */
  heading: React.ReactNode;
  /** Optional secondary line under the heading. */
  subheading?: React.ReactNode;
  /**
   * Optional extra body content (error boxes, hints, detail rows, elapsed timers)
   * rendered between the subheading and the actions row, preserving source order.
   */
  children?: React.ReactNode;
  /** Optional row of action buttons, laid out centred and wrapping. */
  actions?: React.ReactNode;
  /** Extra class on the body wrapper for per-surface tweaks (e.g. a max-width). */
  className?: string;
  /** Test hook forwarded to the body wrapper element. */
  "data-testid"?: string;
}

/**
 * The single shared content-overlay body skeleton (UISF-008). The terminal
 * connect/disconnect overlays, the remote-desktop overlay, and the agent-error
 * tab all rendered the same centred `icon → heading → message → actions` column
 * with per-component class names; this primitive owns that structure once so the
 * surfaces stay consistent by construction.
 *
 * Callers keep their own outer container (backdrop, positioning, dismiss button,
 * hidden state) — those legitimately differ — and render this for the body. The
 * icon is passed through verbatim so each surface controls its icon colour/motion.
 */
export function ContentOverlay({
  icon,
  heading,
  subheading,
  children,
  actions,
  className,
  "data-testid": dataTestId,
}: ContentOverlayProps): React.ReactElement {
  const classes = ["ui-content-overlay", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-testid={dataTestId}>
      {icon}
      <p className="ui-content-overlay__heading">{heading}</p>
      {subheading != null && <p className="ui-content-overlay__subheading">{subheading}</p>}
      {children}
      {actions != null && <div className="ui-content-overlay__actions">{actions}</div>}
    </div>
  );
}
