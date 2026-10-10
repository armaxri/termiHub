import React, { useEffect, useId, useRef } from "react";
import { isFocusUnclaimed } from "@/utils/focusGuard";
import { LiveRegion, type LiveRegionPoliteness } from "./LiveRegion";
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
  /**
   * Marks an in-progress screen (connecting, reconnecting, restoring). Implies
   * `announce="polite"` (unless `announce` is passed explicitly), so the steady
   * text label — which carries the progress signal next to a static spinner
   * under reduced motion (#4039) — is announced to screen readers through the
   * always-mounted {@link LiveRegion} (#4512). The heading itself carries no
   * live attributes: a live region inserted together with its text is often
   * not announced, and two announcing nodes would speak the state twice.
   */
  busy?: boolean;
  /** Optional secondary line under the heading. */
  subheading?: React.ReactNode;
  /**
   * Optional extra body content (error boxes, hints, detail rows, elapsed timers)
   * rendered between the subheading and the actions row, preserving source order.
   */
  children?: React.ReactNode;
  /** Optional row of action buttons, laid out centred and wrapping. */
  actions?: React.ReactNode;
  /**
   * Announce the screen to assistive tech through an always-mounted live region
   * (#4331): `assertive` for failures the user must act on (an `alert`),
   * `polite` for disconnects and other state changes (a `status`). Omit for
   * screens that need no announcement. `busy` screens default to `polite`.
   */
  announce?: LiveRegionPoliteness;
  /**
   * Plain-text announcement. Defaults to the heading plus the subheading when
   * both are strings; pass it explicitly to include an error message rendered
   * in `children`.
   */
  announcement?: string;
  /**
   * Id of a caller-rendered element (typically the error text in `children`)
   * that, with the subheading, forms the body's accessible description.
   */
  describedBy?: string;
  /**
   * Move focus to the first action when the overlay appears or its announcement
   * changes while this is true (#4331). Pass the surface's "is the active tab"
   * flag so background tabs never steal focus. Focus is only taken from the
   * page body or from inside the overlay's host (the nearest
   * `[data-overlay-host]` ancestor, else the overlay's parent), never from a
   * control elsewhere such as a dialog or the sidebar.
   */
  autoFocusPrimaryAction?: boolean;
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
  busy = false,
  subheading,
  children,
  actions,
  announce,
  announcement,
  describedBy,
  autoFocusPrimaryAction = false,
  className,
  "data-testid": dataTestId,
}: ContentOverlayProps): React.ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const subheadingId = useId();
  const spoken = announcement ?? defaultAnnouncement(heading, subheading);
  const politeness: LiveRegionPoliteness | undefined = announce ?? (busy ? "polite" : undefined);

  useEffect(() => {
    if (!autoFocusPrimaryAction) return;
    const body = bodyRef.current;
    const primary = actionsRef.current?.querySelector<HTMLElement>("button:not(:disabled)");
    if (!body || !primary || !isFocusUnclaimed(body)) return;
    primary.focus();
    // Re-run when the announced content changes (a new variant in the same
    // instance), never on an unchanged re-render.
  }, [autoFocusPrimaryAction, spoken]);

  const classes = ["ui-content-overlay", className ?? ""].filter(Boolean).join(" ");
  const describedByIds =
    [subheading != null ? subheadingId : "", describedBy ?? ""].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div
      ref={bodyRef}
      className={classes}
      data-testid={dataTestId}
      role="group"
      aria-labelledby={headingId}
      aria-describedby={describedByIds}
      aria-busy={busy || undefined}
    >
      {politeness && (
        <LiveRegion message={spoken} politeness={politeness} data-testid="content-overlay-live" />
      )}
      {icon}
      <p id={headingId} className="ui-content-overlay__heading">
        {heading}
      </p>
      {subheading != null && (
        <p id={subheadingId} className="ui-content-overlay__subheading">
          {subheading}
        </p>
      )}
      {children}
      {actions != null && (
        <div ref={actionsRef} className="ui-content-overlay__actions">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Heading + subheading as one sentence pair, when both are plain text. A heading
 * that already ends in punctuation ("Connecting…") is not given a second stop.
 */
function defaultAnnouncement(heading: React.ReactNode, subheading: React.ReactNode): string {
  if (typeof heading !== "string") return "";
  if (typeof subheading !== "string") return heading;
  const separator = /[.…!?:]$/.test(heading) ? " " : ". ";
  return `${heading}${separator}${subheading}`;
}
