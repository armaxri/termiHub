import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ResponsiveToolbar } from "@/components/ui";
import type { ToolbarAction } from "@/components/ui";

/**
 * Shared collapsible group header for the connection sidebar (UISF-019).
 *
 * The Connections and Remote Agents section headers in `ConnectionList` were
 * near-identical markup: a `connection-list__group-header` row holding a
 * `connection-list__group-toggle` button (chevron + uppercased title, with
 * `aria-expanded`) and a trailing `connection-list__group-actions` slot of ghost
 * buttons. This component owns that shell so the two headers stop hand-rolling
 * the same DOM; the caller passes the title, the expanded state, the toggle
 * handler, and the action buttons.
 *
 * The BEM classes are unchanged (they are shared with `AgentNode`'s per-agent
 * header and keyed off by CSS + tests), so the rendered header is byte-identical
 * to the previous inline markup.
 */
export interface SidebarGroupHeaderProps {
  /** Section label (rendered uppercased via CSS). */
  title: React.ReactNode;
  /** Whether the group is expanded — drives the chevron and `aria-expanded`. */
  expanded: boolean;
  /** Toggle the group's collapsed state. */
  onToggle: () => void;
  /**
   * Action controls rendered in the trailing `group-actions` slot. Pass a
   * {@link ToolbarAction} array to make them width-responsive (#4709): they
   * stay icon buttons while they fit beside the title and collapse into an
   * overflow "…" menu below that, instead of clipping in a narrow sidebar.
   */
  actions?: React.ReactNode | ToolbarAction[];
  /** Accessible name of the responsive action group (array `actions` only). */
  actionsLabel?: string;
  /** `data-testid` for the header wrapper. */
  headerTestId?: string;
  /** `data-testid` for the toggle button. */
  toggleTestId?: string;
}

/**
 * Width (px) kept for the chevron + a few letters of the title before the
 * responsive actions start collapsing into the overflow menu.
 */
const GROUP_TITLE_MIN_WIDTH = 80;

/** The collapsible section header shared by the connection sidebar groups. */
export function SidebarGroupHeader({
  title,
  expanded,
  onToggle,
  actions,
  headerTestId,
  toggleTestId,
  actionsLabel,
}: SidebarGroupHeaderProps) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const toggle = (
    <button
      className="connection-list__group-toggle"
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid={toggleTestId}
    >
      <Chevron size={16} className="connection-tree__chevron" />
      <span className="connection-list__group-title">{title}</span>
    </button>
  );
  if (Array.isArray(actions)) {
    return (
      <ResponsiveToolbar
        className="connection-list__group-header"
        data-testid={headerTestId}
        aria-label={actionsLabel ?? "Section actions"}
        leading={toggle}
        leadingMinWidth={GROUP_TITLE_MIN_WIDTH}
        overflowLabel={actionsLabel ? `More ${actionsLabel.toLowerCase()}` : undefined}
        overflowTestId={headerTestId ? `${headerTestId}-overflow` : undefined}
        actions={actions}
      />
    );
  }
  return (
    <div className="connection-list__group-header" data-testid={headerTestId}>
      {toggle}
      {actions !== undefined && <div className="connection-list__group-actions">{actions}</div>}
    </div>
  );
}
