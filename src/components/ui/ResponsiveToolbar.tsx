import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { useElementWidth } from "@/hooks/useElementWidth";
import { errorMessage } from "@/utils/errorMessage";
import { Button } from "./Button";
import {
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "./Menu";
import { Tooltip } from "./Tooltip";
import { toast } from "./Toast";
import "./ui.css";

/**
 * One entry of a {@link ToolbarAction}'s drop-down menu: a selectable item, a
 * separator, or a non-interactive group label.
 */
export type ToolbarMenuEntry =
  | {
      type?: "item";
      id: string;
      label: React.ReactNode;
      icon?: React.ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      testId?: string;
    }
  | { type: "separator"; id: string }
  | { type: "label"; id: string; label: React.ReactNode };

/**
 * One action of a {@link ResponsiveToolbar}. The toolbar decides how it renders
 * — as a labelled button, or as an entry of the overflow "…" menu — from the
 * width it actually has, so every action stays reachable at any width.
 */
export interface ToolbarAction {
  /** Stable key. */
  id: string;
  /**
   * Accessible name. Always the button's `aria-label`, the tooltip text (unless
   * {@link ToolbarAction.tooltip} overrides it) and the overflow-menu text.
   */
  label: string;
  /**
   * Visible text when there is room for labels. Defaults to `label`. Keep it a
   * prefix/substring of `label` so the visible text stays part of the
   * accessible name (WCAG 2.5.3 label-in-name).
   */
  shortLabel?: string;
  /** Leading icon of the button and of its overflow-menu entry. */
  icon: React.ReactNode;
  /** Click handler (may be async; a rejection from the menu surfaces a toast). */
  onClick?: () => void | Promise<void>;
  /** Disable the action in every form. */
  disabled?: boolean;
  /** Tooltip content override (defaults to `label`). */
  tooltip?: React.ReactNode;
  /** Always render icon-only, even when labels would fit (e.g. export/import). */
  iconOnly?: boolean;
  /**
   * The toolbar's main action (e.g. "New …"). When the actions do not all fit,
   * it stays an inline button next to the "…" menu instead of moving into it.
   * Only the first action marked primary counts.
   */
  primary?: boolean;
  /** `data-testid` of the button — and of its overflow-menu item. */
  testId?: string;
  /**
   * Turn the action into a drop-down: clicking opens these entries instead of
   * calling `onClick`. In the overflow menu it becomes a sub-menu.
   */
  menu?: ToolbarMenuEntry[];
}

/**
 * How the toolbar lays out its actions at the current width: every action as
 * a labelled button (`"full"`), or the primary action (if any) next to one
 * overflow "…" menu holding the rest (`"overflow"`). There is deliberately no
 * icon-only row in between (#4824) — a single "…" reads calmer.
 */
export type ToolbarLayoutMode = "full" | "overflow";

/** Result of {@link computeToolbarLayout}. */
export interface ToolbarLayout {
  mode: ToolbarLayoutMode;
  /**
   * Index of the action rendered inline in `"overflow"` mode (the primary
   * action, when it fits beside the "…" trigger), else `null`. Every other
   * action is in the overflow menu. Always `null` in `"full"` mode.
   */
  inlineIndex: number | null;
}

/** Inputs of {@link computeToolbarLayout}, all in CSS pixels. */
export interface ToolbarLayoutInput {
  /** Width available to the actions, or `null` when unknown (no layout yet). */
  available: number | null;
  /** Per action, the width it needs in the labelled ("full") form. */
  fullWidths: number[];
  /** Width of the overflow "…" trigger (an icon-only button). */
  iconWidth: number;
  /** Flex gap between adjacent controls. */
  gap: number;
  /** Index of the primary action, or `null` when the toolbar declares none. */
  primaryIndex?: number | null;
}

/**
 * Pure layout decision for a {@link ResponsiveToolbar}: labelled buttons when
 * they all fit; otherwise the primary action (labelled, when it fits next to
 * the trigger) plus one overflow "…" menu holding the rest. An unknown width
 * (`null`) means "unconstrained" — the full layout.
 */
export function computeToolbarLayout({
  available,
  fullWidths,
  iconWidth,
  gap,
  primaryIndex = null,
}: ToolbarLayoutInput): ToolbarLayout {
  const n = fullWidths.length;
  if (available === null || n === 0) return { mode: "full", inlineIndex: null };
  const full = fullWidths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, n - 1);
  // Sub-pixel rounding in measured widths must not flip a toolbar that fits.
  const slack = 0.5;
  if (full <= available + slack) return { mode: "full", inlineIndex: null };
  if (primaryIndex !== null && primaryIndex >= 0 && primaryIndex < n) {
    // Room for the labelled primary plus the "…" trigger that holds the rest.
    const needed = fullWidths[primaryIndex] + gap + iconWidth;
    if (needed <= available + slack) return { mode: "overflow", inlineIndex: primaryIndex };
  }
  return { mode: "overflow", inlineIndex: null };
}

/** Fallback icon-button width when layout cannot be measured (jsdom). */
const FALLBACK_ICON_WIDTH = 28;
/** Fallback per-character label width when layout cannot be measured (jsdom). */
const FALLBACK_CHAR_WIDTH = 7;
/** Fallback width of a drop-down action's chevron (icon + gap). */
const FALLBACK_CHEVRON_WIDTH = 16;
/** Fallback flex gap (`--spacing-xs`). */
const FALLBACK_GAP = 4;

/** Estimated labelled width of an action when the DOM cannot be measured. */
function estimateFullWidth(action: ToolbarAction): number {
  if (action.iconOnly) return FALLBACK_ICON_WIDTH;
  const text = action.shortLabel ?? action.label;
  return (
    FALLBACK_ICON_WIDTH +
    text.length * FALLBACK_CHAR_WIDTH +
    (action.menu ? FALLBACK_CHEVRON_WIDTH : 0)
  );
}

/** True when a value is a thenable. */
function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown })?.then === "function";
}

/** Run an action from a menu, surfacing an async failure as a toast. */
function runFromMenu(action: ToolbarAction): void {
  const result = action.onClick?.();
  if (isPromise(result)) {
    result.catch((err: unknown) => toast.error(errorMessage(err)));
  }
}

/** Render a drop-down action's entries with the shared Menu parts. */
function renderEntries(entries: ToolbarMenuEntry[]): React.ReactNode {
  return entries.map((entry) => {
    if (entry.type === "separator") return <MenuSeparator key={entry.id} />;
    if (entry.type === "label") return <MenuLabel key={entry.id}>{entry.label}</MenuLabel>;
    return (
      <MenuItem
        key={entry.id}
        icon={entry.icon}
        disabled={entry.disabled}
        onSelect={entry.onSelect}
        data-testid={entry.testId}
      >
        {entry.label}
      </MenuItem>
    );
  });
}

/** Props for {@link ResponsiveToolbar}. */
export interface ResponsiveToolbarProps {
  /** The actions, in display order (mark the main one `primary`). */
  actions: ToolbarAction[];
  /** Accessible name of the action group. */
  "aria-label": string;
  /**
   * Optional leading content (e.g. a section title) that takes the remaining
   * width and truncates; the actions collapse once it would drop below
   * `leadingMinWidth`.
   */
  leading?: React.ReactNode;
  /** Width (px) reserved for `leading` before the actions start collapsing. */
  leadingMinWidth?: number;
  /** Accessible name / tooltip of the overflow trigger. Defaults to "More actions". */
  overflowLabel?: string;
  /** `data-testid` of the overflow trigger. */
  overflowTestId?: string;
  /** Tooltip side for the inline buttons. Defaults to `"top"`. */
  tooltipSide?: "top" | "bottom" | "left" | "right";
  /** Extra class(es) for the root. */
  className?: string;
  /** `data-testid` of the root. */
  "data-testid"?: string;
}

/**
 * The shared width-responsive action strip (#4709, #4824). Actions render
 * labelled while they all fit; below that the primary action (if one is
 * declared) stays inline and everything else moves into a single overflow "…"
 * menu, so a control is never clipped or hidden whatever the sidebar width. Width comes from a
 * `ResizeObserver`; the labelled widths come from an invisible measuring copy,
 * so the decision never oscillates with the layout it produces.
 */
export function ResponsiveToolbar({
  actions,
  "aria-label": ariaLabel,
  leading,
  leadingMinWidth = 0,
  overflowLabel = "More actions",
  overflowTestId,
  tooltipSide = "top",
  className,
  "data-testid": testId,
}: ResponsiveToolbarProps): React.ReactElement {
  const [observeRef, width] = useElementWidth<HTMLDivElement>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  // The measuring copy's own width changes when web fonts finish loading (or
  // the theme's font changes), which changes every labelled width — re-measure.
  const [observeMeasure, measureWidth] = useElementWidth<HTMLDivElement>();
  const setMeasureRef = useCallback(
    (node: HTMLDivElement | null) => {
      measureRef.current = node;
      observeMeasure(node);
    },
    [observeMeasure]
  );
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      observeRef(node);
    },
    [observeRef]
  );

  const [metrics, setMetrics] = useState<{
    fullWidths: number[];
    iconWidth: number;
    gap: number;
  } | null>(null);

  // Re-measure only when what the labelled form looks like changes.
  const measureKey = actions
    .map((a) => `${a.id}:${a.iconOnly ? "" : (a.shortLabel ?? a.label)}:${a.menu ? 1 : 0}`)
    .join("|");

  useLayoutEffect(() => {
    const measure = measureRef.current;
    const root = rootRef.current;
    const nodes = measure ? Array.from(measure.children) : [];
    const iconNode = nodes[nodes.length - 1];
    const measuredIcon = iconNode?.getBoundingClientRect().width ?? 0;
    const iconWidth = measuredIcon > 0 ? measuredIcon : FALLBACK_ICON_WIDTH;
    const fullWidths = actions.map((action, i) => {
      if (action.iconOnly) return iconWidth;
      const w = nodes[i]?.getBoundingClientRect().width ?? 0;
      return w > 0 ? w : estimateFullWidth(action);
    });
    const gapValue = root ? parseFloat(getComputedStyle(root).columnGap) : NaN;
    const gap = Number.isFinite(gapValue) ? gapValue : FALLBACK_GAP;
    setMetrics({ fullWidths, iconWidth, gap });
    // `actions` identity churns every render; the key captures what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureKey, measureWidth]);

  const available =
    width === null ? null : leading != null ? Math.max(0, width - leadingMinWidth) : width;

  const primaryIndex = actions.findIndex((a) => a.primary);

  const layout = useMemo<ToolbarLayout>(
    () =>
      metrics
        ? computeToolbarLayout({
            available,
            ...metrics,
            primaryIndex: primaryIndex >= 0 ? primaryIndex : null,
          })
        : { mode: "full", inlineIndex: null },
    [available, metrics, primaryIndex]
  );

  const inline =
    layout.mode === "full"
      ? actions
      : layout.inlineIndex !== null
        ? [actions[layout.inlineIndex]]
        : [];
  const overflow = layout.mode === "full" ? [] : actions.filter((_, i) => i !== layout.inlineIndex);

  const classes = ["ui-toolbar", className ?? ""].filter(Boolean).join(" ");

  return (
    <div
      ref={setRootRef}
      className={classes}
      data-testid={testId}
      data-layout={layout.mode}
      role="group"
      aria-label={ariaLabel}
    >
      {leading != null && <div className="ui-toolbar__leading">{leading}</div>}
      {inline.map((action) => (
        <InlineAction
          key={action.id}
          action={action}
          showLabel={!action.iconOnly}
          tooltipSide={tooltipSide}
        />
      ))}
      {overflow.length > 0 && (
        <DropdownMenuRoot>
          <Tooltip content={overflowLabel} side={tooltipSide}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<MoreHorizontal size={14} />}
                aria-label={overflowLabel}
                className="ui-toolbar__overflow"
                data-testid={overflowTestId}
              />
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" sideOffset={4}>
            {overflow.map((action) =>
              action.menu ? (
                <MenuSub key={action.id}>
                  <MenuSubTrigger
                    icon={action.icon}
                    disabled={action.disabled}
                    data-testid={action.testId}
                  >
                    {action.label}
                  </MenuSubTrigger>
                  <MenuSubContent sideOffset={4}>{renderEntries(action.menu)}</MenuSubContent>
                </MenuSub>
              ) : (
                <MenuItem
                  key={action.id}
                  icon={action.icon}
                  disabled={action.disabled}
                  onSelect={() => runFromMenu(action)}
                  data-testid={action.testId}
                >
                  {action.label}
                </MenuItem>
              )
            )}
          </DropdownMenuContent>
        </DropdownMenuRoot>
      )}
      {/* Invisible measuring copy of every labelled form, plus one icon-only
          button (last child). Disabled + aria-hidden so it is never focusable
          or announced; it only lends its natural widths to the layout. */}
      <div className="ui-toolbar__measure" ref={setMeasureRef} aria-hidden="true">
        {actions.map((action) => (
          <Button
            key={action.id}
            variant="ghost"
            size="sm"
            icon={action.icon}
            disabled
            tabIndex={-1}
          >
            {action.shortLabel ?? action.label}
            {action.menu ? <ChevronDown size={12} /> : null}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<MoreHorizontal size={14} />}
          disabled
          tabIndex={-1}
          aria-label="measure"
        />
      </div>
    </div>
  );
}

/** Props for one inline action. */
interface InlineActionProps {
  action: ToolbarAction;
  showLabel: boolean;
  tooltipSide: "top" | "bottom" | "left" | "right";
}

/** One action rendered inline — labelled (or `iconOnly`), button or drop-down. */
function InlineAction({ action, showLabel, tooltipSide }: InlineActionProps) {
  const button = (
    <Button
      variant="ghost"
      size="sm"
      iconOnly={!showLabel}
      icon={action.icon}
      onClick={action.menu ? undefined : action.onClick}
      disabled={action.disabled}
      aria-label={action.label}
      data-testid={action.testId}
    >
      {showLabel ? (
        <>
          {action.shortLabel ?? action.label}
          {action.menu ? <ChevronDown size={12} /> : null}
        </>
      ) : undefined}
    </Button>
  );

  if (!action.menu) {
    return (
      <Tooltip content={action.tooltip ?? action.label} side={tooltipSide}>
        {button}
      </Tooltip>
    );
  }

  return (
    <DropdownMenuRoot>
      <Tooltip content={action.tooltip ?? action.label} side={tooltipSide}>
        <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" sideOffset={4}>
        {renderEntries(action.menu)}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
