import React from "react";
import { ResponsiveToolbar } from "@/components/ui";
import type { ToolbarAction } from "@/components/ui";
import "./SidebarToolbar.css";

/**
 * Shared sidebar toolbar (actions bar) chrome (UISF-019).
 *
 * Every management sidebar opens with a top actions row — a flex strip of ghost
 * buttons (New / Record / export / import) sitting above the list, with a
 * bottom border. Each sidebar used to hand-roll this as its own
 * `X-sidebar__actions` div plus a near-identical per-file CSS rule
 * (`display: flex; padding: 4px 8px; gap: 4px; border-bottom`). This component
 * owns that shell so the sidebars stop duplicating — and drifting — the same
 * markup and layout; callers pass the action buttons as `children`.
 *
 * Width-responsive (#4709): pass `actions` (not `children`) and the strip is a
 * {@link ResponsiveToolbar} — labelled buttons while they fit, icon-only buttons
 * with a tooltip below that, and an overflow "…" menu after that — so no
 * control is ever clipped or hidden in a narrow sidebar. `children` remains for
 * content that is not a list of actions; it renders verbatim.
 */
export interface SidebarToolbarProps {
  /** Free-form content laid out in the strip (prefer `actions`). */
  children?: React.ReactNode;
  /** The actions, in priority order; makes the strip width-responsive. */
  actions?: ToolbarAction[];
  /** Accessible name of the action group (with `actions`). */
  "aria-label"?: string;
  /** Accessible name of the overflow "…" trigger (with `actions`). */
  overflowLabel?: string;
  /** `data-testid` of the overflow "…" trigger (with `actions`). */
  overflowTestId?: string;
  /**
   * `align-items` override. Default is the flex initial (`stretch`); pass
   * `"center"` to vertically centre controls of differing heights.
   */
  align?: "center";
  /**
   * `justify-content` override. Default is `flex-start`; pass `"end"` to push a
   * lone trailing action (e.g. a clear button) to the right edge.
   */
  justify?: "end";
  /** Optional extra class(es) appended to the shared `sidebar-toolbar` class. */
  className?: string;
  /** Optional `data-testid` for the toolbar wrapper. */
  "data-testid"?: string;
}

/** The top actions strip shared by the management sidebars. */
export function SidebarToolbar({
  children,
  actions,
  "aria-label": ariaLabel,
  overflowLabel,
  overflowTestId,
  align,
  justify,
  className,
  "data-testid": testId,
}: SidebarToolbarProps) {
  const classes = ["sidebar-toolbar"];
  if (align === "center") classes.push("sidebar-toolbar--align-center");
  if (justify === "end") classes.push("sidebar-toolbar--justify-end");
  if (className) classes.push(className);
  if (actions) {
    return (
      <ResponsiveToolbar
        actions={actions}
        aria-label={ariaLabel ?? "Actions"}
        overflowLabel={overflowLabel}
        overflowTestId={overflowTestId}
        className={classes.join(" ")}
        data-testid={testId}
      />
    );
  }
  return (
    <div className={classes.join(" ")} data-testid={testId}>
      {children}
    </div>
  );
}
