import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";

/**
 * Shared row primitives for the connection + agent sidebar trees.
 *
 * Both the local Connections tree (`ConnectionList`) and the Remote Agents tree
 * (`AgentNode`) render depth-indented folder and item rows with an identical
 * markup shell: the same `connection-tree__folder` / `connection-tree__item`
 * BEM classes, the same `paddingLeft: depth * 16 + 8` indentation, the same
 * `role="treeitem"` / `aria-*` / roving-`tabIndex` wiring, and the same
 * className-modifier scheme (`--dragging` / `--selected` / `--persistent` /
 * `--reorder-over` / `--drop-over`). These components own that shell so the two
 * trees stop hand-rolling — and drifting — the same DOM (UISF-017).
 *
 * They are deliberately behaviour-free: drag-and-drop wiring, selection state,
 * keyboard handlers, and the per-row content (icons, badges, status, actions)
 * are all passed in by the caller, so the rendered DOM for a given set of props
 * is byte-identical to the previous inline markup.
 */

/** Left padding (px) for a tree row at `depth`, matching the shared indent. */
export function treeRowPaddingLeft(depth: number): number {
  return depth * 16 + 8;
}

/** The drag attributes/listeners a caller obtains from dnd-kit's `useDraggable`. */
type DragAttributes = ReturnType<typeof useDraggable>["attributes"];
type DragListeners = ReturnType<typeof useDraggable>["listeners"];

/** Props for {@link TreeFolderRow}. */
export interface TreeFolderRowProps {
  /** Ref callback for the folder button (drop-target + roving-nav row). */
  buttonRef: (el: HTMLButtonElement | null) => void;
  /** Folder label. */
  label: React.ReactNode;
  /** Whether the folder is expanded (drives the chevron + `aria-expanded`). */
  expanded: boolean;
  /** Left padding in pixels (typically `treeRowPaddingLeft(depth)`). */
  indentPx: number;
  /** ARIA tree depth (1-based). */
  ariaLevel: number;
  /** Roving-tabindex value for this row (`0` when active, else `-1`). */
  tabIndex: number;
  /** Highlight the row as an active drop target (`--drop-over` modifier). */
  dropOver?: boolean;
  /** Optional `data-testid` for the button. */
  testId?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
}

/**
 * A depth-indented folder row for the sidebar trees: folder icon, label, and a
 * trailing expand/collapse chevron, wrapped in the shared
 * `connection-tree__folder` button with tree ARIA + roving-tabindex wiring.
 */
export function TreeFolderRow({
  buttonRef,
  label,
  expanded,
  indentPx,
  ariaLevel,
  tabIndex,
  dropOver = false,
  testId,
  onClick,
  onKeyDown,
  onFocus,
}: TreeFolderRowProps): React.ReactElement {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const className = `connection-tree__folder${dropOver ? " connection-tree__folder--drop-over" : ""}`;
  return (
    <button
      ref={buttonRef}
      className={className}
      onClick={onClick}
      style={{ paddingLeft: indentPx }}
      data-testid={testId}
      role="treeitem"
      aria-expanded={expanded}
      aria-level={ariaLevel}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <Folder size={16} />
      <span className="connection-tree__label">{label}</span>
      <Chevron size={16} className="connection-tree__chevron" />
    </button>
  );
}

/** Modifier flags → `connection-tree__item--*` classes, applied in order. */
function treeItemClassName({
  dragging,
  selected,
  persistent,
  reorderOver,
}: {
  dragging?: boolean;
  selected?: boolean;
  persistent?: boolean;
  reorderOver?: boolean;
}): string {
  let className = "connection-tree__item";
  if (dragging) className += " connection-tree__item--dragging";
  if (selected) className += " connection-tree__item--selected";
  if (persistent) className += " connection-tree__item--persistent";
  if (reorderOver) className += " connection-tree__item--reorder-over";
  return className;
}

/** Props for {@link TreeItemRow}. */
export interface TreeItemRowProps {
  /** Ref callback for the item button (draggable/droppable + roving-nav row). */
  buttonRef: (el: HTMLButtonElement | null) => void;
  /** Left padding in pixels (typically `treeRowPaddingLeft(depth)`). */
  indentPx: number;
  /** ARIA tree depth. */
  ariaLevel: number;
  /** Roving-tabindex value for this row (`0` when active, else `-1`). */
  tabIndex: number;
  /**
   * Selection state for `aria-selected`. Omit for rows that are not selectable
   * (e.g. live agent sessions), which then render without the attribute.
   */
  ariaSelected?: boolean;
  /** Row content (icon, label, badges, status dot, actions). */
  children: React.ReactNode;
  /** Modifier flag → `--dragging`. */
  dragging?: boolean;
  /** Modifier flag → `--selected`. */
  selected?: boolean;
  /** Modifier flag → `--persistent`. */
  persistent?: boolean;
  /** Modifier flag → `--reorder-over`. */
  reorderOver?: boolean;
  /** Native `title` (hover help). */
  title?: string;
  /** Optional `data-testid` for the button. */
  testId?: string;
  /** dnd-kit draggable attributes to spread onto the button. */
  dragAttributes?: DragAttributes;
  /** dnd-kit draggable listeners to spread onto the button. */
  dragListeners?: DragListeners;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  onDoubleClick?: React.MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
}

/**
 * A depth-indented item (connection / session) row for the sidebar trees: the
 * shared `connection-tree__item` button with modifier-class assembly, indent,
 * optional drag wiring, and tree ARIA + roving-tabindex. The row's visible
 * content is provided via `children`, so each tree keeps its own icons, badges,
 * and action controls while sharing one shell.
 */
export function TreeItemRow({
  buttonRef,
  indentPx,
  ariaLevel,
  tabIndex,
  ariaSelected,
  children,
  dragging,
  selected,
  persistent,
  reorderOver,
  title,
  testId,
  dragAttributes,
  dragListeners,
  onClick,
  onDoubleClick,
  onKeyDown,
  onFocus,
}: TreeItemRowProps): React.ReactElement {
  const className = treeItemClassName({ dragging, selected, persistent, reorderOver });
  return (
    <button
      ref={buttonRef}
      className={className}
      style={{ paddingLeft: indentPx }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
      data-testid={testId}
      {...(dragAttributes ?? {})}
      {...(dragListeners ?? {})}
      role="treeitem"
      aria-level={ariaLevel}
      aria-selected={ariaSelected}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {children}
    </button>
  );
}
