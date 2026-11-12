import React, { Fragment, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Check, MoreHorizontal } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuCheckboxItem,
  MenuItem,
  MenuItemIndicator,
  MenuSeparator,
  Tooltip,
} from "@/components/ui";
import { useElementWidth } from "@/hooks/useElementWidth";

/** Menu section of a {@link FileBrowserAction}; sections are split by separators. */
export type FileBrowserActionGroup = "navigate" | "terminal" | "create" | "view" | "open";

/** Section order of the overflow menu. */
const GROUP_ORDER: FileBrowserActionGroup[] = ["navigate", "terminal", "create", "view", "open"];

/**
 * One action of the file browser's header (#5520). An action with an `inline`
 * priority is an icon button while the row has room for it; every other action
 * — and every inline one the row cannot fit — is a labelled entry of the "…"
 * overflow menu. The same `testId` marks the button and the menu entry.
 */
export interface FileBrowserAction {
  /** Stable key. */
  id: string;
  /** Accessible name of the button, and the text of its menu entry. */
  label: string;
  /** Tooltip of the inline button (defaults to `label`). */
  tooltip?: React.ReactNode;
  /** Icon of the button and of its menu entry. */
  icon: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** `data-testid` of the button and of its menu entry. */
  testId: string;
  /** Overflow-menu section. */
  group: FileBrowserActionGroup;
  /**
   * Inline priority: lower numbers stay inline longest as the row narrows.
   * Omit to keep the action in the overflow menu only.
   */
  inline?: number;
  /** Never moved into the menu, whatever the width (the row's core navigation). */
  pinned?: boolean;
  /** A toggle: `aria-pressed` inline, a checkbox entry in the menu. */
  checked?: boolean;
  /** `aria-busy` of the inline button (Refresh while a listing is in flight). */
  busy?: boolean;
  /** Visible text beside the icon of the inline button (e.g. "Refreshing…"). */
  inlineText?: string;
  /**
   * Render this node in the menu instead of a plain entry — e.g. a sub-menu.
   * Such an action is always menu-only.
   */
  menuNode?: React.ReactNode;
}

/** Inputs of {@link fitInlineActions}, all widths in CSS pixels. */
export interface FitInlineInput {
  /** Width of the action row, or `null` when unknown (no layout yet: fit all). */
  available: number | null;
  /** Width of each inline candidate, in priority order (most important first). */
  widths: number[];
  /** How many leading candidates are pinned (always inline). */
  pinned: number;
  /** Width of the "…" trigger. */
  triggerWidth: number;
  /** Flex gap between adjacent controls. */
  gap: number;
}

/**
 * How many of the priority-ordered inline candidates fit beside the "…"
 * trigger. Never fewer than the pinned ones; an unknown width fits them all.
 */
export function fitInlineActions({
  available,
  widths,
  pinned,
  triggerWidth,
  gap,
}: FitInlineInput): number {
  if (available === null) return widths.length;
  // Sub-pixel rounding in measured widths must not drop an action that fits.
  const slack = 0.5;
  let used = triggerWidth;
  let count = 0;
  for (const w of widths) {
    if (used + gap + w > available + slack) break;
    used += gap + w;
    count++;
  }
  return Math.max(Math.min(pinned, widths.length), count);
}

/** Fallback icon-button width when layout cannot be measured (jsdom). */
const FALLBACK_ICON_WIDTH = 28;
/** Fallback flex gap (`--spacing-xxs`). */
const FALLBACK_GAP = 2;
/** Estimated width of an inline button's visible text, per character. */
const CHAR_WIDTH = 7;

/** Props for {@link FileBrowserActions}. */
export interface FileBrowserActionsProps {
  /** Every action, in display order. */
  actions: FileBrowserAction[];
  /** Accessible name and tooltip of the overflow trigger. */
  overflowLabel?: string;
}

/**
 * The file browser's action row (#5520): the few most-used actions as icon
 * buttons, everything else in one "…" overflow menu of labelled entries. As the
 * sidebar narrows, the lowest-priority inline actions move into the menu too,
 * so the row never wraps or clips. Width comes from a `ResizeObserver` on the
 * full-width row, so the decision never feeds back into the width it reads.
 */
export function FileBrowserActions({
  actions,
  overflowLabel = "More actions",
}: FileBrowserActionsProps): React.ReactElement {
  const [observeRow, width] = useElementWidth<HTMLDivElement>();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      observeRow(node);
    },
    [observeRow]
  );
  const [metrics, setMetrics] = useState({ iconWidth: FALLBACK_ICON_WIDTH, gap: FALLBACK_GAP });

  useLayoutEffect(() => {
    const measured = triggerRef.current?.getBoundingClientRect().width ?? 0;
    const gapValue = rowRef.current ? parseFloat(getComputedStyle(rowRef.current).columnGap) : NaN;
    const next = {
      iconWidth: measured > 0 ? measured : FALLBACK_ICON_WIDTH,
      gap: Number.isFinite(gapValue) ? gapValue : FALLBACK_GAP,
    };
    setMetrics((prev) =>
      prev.iconWidth === next.iconWidth && prev.gap === next.gap ? prev : next
    );
  }, [width]);

  // Inline candidates, most important first: pinned ones, then by priority.
  const candidates = actions
    .filter((a) => a.inline !== undefined && a.menuNode === undefined)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.inline! - b.inline!);
  const fit = fitInlineActions({
    available: width,
    widths: candidates.map(
      (a) => metrics.iconWidth + (a.inlineText ? a.inlineText.length * CHAR_WIDTH : 0)
    ),
    pinned: candidates.filter((a) => a.pinned).length,
    triggerWidth: metrics.iconWidth,
    gap: metrics.gap,
  });
  const inlineIds = new Set(candidates.slice(0, fit).map((a) => a.id));
  const inline = actions.filter((a) => inlineIds.has(a.id));
  const collapsed = actions.filter((a) => a.inline !== undefined && !inlineIds.has(a.id));
  const menuOnly = actions.filter((a) => a.inline === undefined || a.menuNode !== undefined);

  // The menu: collapsed inline actions first, then each section in turn.
  const sections: FileBrowserAction[][] = [
    collapsed,
    ...GROUP_ORDER.map((g) => menuOnly.filter((a) => a.group === g)),
  ].filter((s) => s.length > 0);

  return (
    <div
      ref={setRowRef}
      className="file-browser__actions"
      role="toolbar"
      aria-label="File actions"
      data-testid="file-browser-actions"
      data-inline-count={inline.length}
    >
      {inline.map((action) => (
        <Tooltip key={action.id} content={action.tooltip ?? action.label} side="top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly={!action.inlineText}
            icon={action.icon}
            onClick={action.onClick}
            disabled={action.disabled}
            aria-label={action.label}
            aria-pressed={action.checked}
            aria-busy={action.busy}
            data-testid={action.testId}
          >
            {action.inlineText}
          </Button>
        </Tooltip>
      ))}
      <span className="file-browser__actions-spacer" aria-hidden="true" />
      <DropdownMenuRoot>
        <Tooltip content={overflowLabel} side="top">
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              variant="ghost"
              size="sm"
              iconOnly
              icon={<MoreHorizontal size={14} />}
              aria-label={overflowLabel}
              className="file-browser__actions-overflow"
              data-testid="file-browser-more-actions"
            />
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} data-testid="file-browser-more-menu">
          {sections.map((section, i) => (
            <Fragment key={section[0].id}>
              {i > 0 && <MenuSeparator />}
              {section.map((action) => (
                <ActionMenuEntry key={action.id} action={action} />
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
  );
}

/** One action as an overflow-menu entry. */
function ActionMenuEntry({ action }: { action: FileBrowserAction }) {
  if (action.menuNode !== undefined) return <>{action.menuNode}</>;
  if (action.checked !== undefined) {
    return (
      <MenuCheckboxItem
        checked={action.checked}
        disabled={action.disabled}
        onSelect={action.onClick}
        data-testid={action.testId}
      >
        <MenuItemIndicator>
          <Check size={14} />
        </MenuItemIndicator>
        {action.icon} {action.label}
      </MenuCheckboxItem>
    );
  }
  return (
    <MenuItem
      icon={action.icon}
      disabled={action.disabled}
      onSelect={action.onClick}
      data-testid={action.testId}
    >
      {action.label}
    </MenuItem>
  );
}
