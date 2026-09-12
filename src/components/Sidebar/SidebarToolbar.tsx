import React from "react";
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
 * Behaviour-free: it renders one wrapper element and its children verbatim, so
 * the rendered button set, tooltips, and testids are unchanged from the inline
 * markup it replaces.
 */
export interface SidebarToolbarProps {
  /** The action controls (buttons, dropdown triggers) laid out in the strip. */
  children: React.ReactNode;
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
  align,
  justify,
  className,
  "data-testid": testId,
}: SidebarToolbarProps) {
  const classes = ["sidebar-toolbar"];
  if (align === "center") classes.push("sidebar-toolbar--align-center");
  if (justify === "end") classes.push("sidebar-toolbar--justify-end");
  if (className) classes.push(className);
  return (
    <div className={classes.join(" ")} data-testid={testId}>
      {children}
    </div>
  );
}
