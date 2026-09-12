import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

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
  /** Action controls rendered in the trailing `group-actions` slot. */
  actions?: React.ReactNode;
  /** `data-testid` for the header wrapper. */
  headerTestId?: string;
  /** `data-testid` for the toggle button. */
  toggleTestId?: string;
}

/** The collapsible section header shared by the connection sidebar groups. */
export function SidebarGroupHeader({
  title,
  expanded,
  onToggle,
  actions,
  headerTestId,
  toggleTestId,
}: SidebarGroupHeaderProps) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="connection-list__group-header" data-testid={headerTestId}>
      <button
        className="connection-list__group-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid={toggleTestId}
      >
        <Chevron size={16} className="connection-tree__chevron" />
        <span className="connection-list__group-title">{title}</span>
      </button>
      {actions !== undefined && <div className="connection-list__group-actions">{actions}</div>}
    </div>
  );
}
