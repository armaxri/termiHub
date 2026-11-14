import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { StatusDot } from "../ui/StatusDot";
import { Tooltip } from "../ui/Tooltip";
import { TruncatedText } from "../ui/TruncatedText";
import { rowTooltipDescription } from "./rowTooltip";
import type { StatusTone } from "../ui/StatusDot";
import "./SidebarListItem.css";

/**
 * @deprecated The sidebar status dot was promoted to the shared {@link StatusDot}
 * primitive in `src/components/ui/` (UISF-003). Import `StatusDot` from
 * `@/components/ui` for new call sites; these aliases keep existing sidebar rows
 * working.
 */
export type SidebarStatusTone = StatusTone;
/** @deprecated Alias of {@link StatusDot}. See {@link SidebarStatusTone}. */
export const SidebarStatusDot = StatusDot;

/**
 * Props for the shared {@link SidebarListItem} shell. Extends the native `div`
 * attributes, so extra props (including `onDoubleClick` and the props/ref a
 * Radix `*.Trigger asChild` injects) are forwarded to the row container.
 */
export interface SidebarListItemProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Primary label for the row. */
  name: React.ReactNode;
  /** Test hook for the name element. */
  nameTestId?: string;
  /**
   * Tooltip for a cut name; defaults to `name`. Use when the visible name is a
   * shortened form of something longer (a URL shown without its scheme).
   */
  nameTooltip?: React.ReactNode;
  /**
   * Action controls (compose from the shared Button primitive). Revealed on
   * hover/focus as an overlay on the row's trailing edge, so while hidden they
   * reserve no width and the name gets the whole row (#4709). When the overlay
   * would leave no readable stub of the name (a narrow row with many actions),
   * they are revealed on a second line below the name instead (#4972).
   */
  actions: React.ReactNode;
  /** Optional leading status indicator (typically a {@link SidebarStatusDot}). */
  status?: React.ReactNode;
  /** Optional badge content shown next to the name (e.g. a protocol/type tag). */
  badge?: React.ReactNode;
  /** Test hook forwarded to the badge element. */
  badgeTestId?: string;
  /** Optional detail lines shown beneath the header. */
  details?: React.ReactNode;
  /** Test hook for the row container. */
  testId?: string;
  /** Apply the error modifier (keeps recovery actions visible). */
  error?: boolean;
  /**
   * Keep the actions visible in the row's flow instead of revealing them on
   * hover/focus (#5612): for rows whose controls are the point of the list (a
   * schedule's enable switch). The name ellipsizes before them.
   */
  actionsVisible?: boolean;
  /**
   * The short description the user wrote for the item (#5757), shown muted
   * on one line under the name. Omitted, empty or blank: no line.
   */
  description?: string;
  /** Test hook for the description line. */
  descriptionTestId?: string;
  /**
   * The item's configuration and detail text (#5757): how it is launched,
   * what it targets, when it last ran, its tags. Rows show the name, the
   * description and markers that need attention; everything else goes here.
   * Shown in a tooltip on the name (under the full name), and set as the
   * row's accessible description so keyboard and screen-reader users reach it
   * too. Omitted or empty: the name keeps its clip-only tooltip.
   */
  tooltip?: readonly string[];
  /** Test hook for the tooltip content. */
  tooltipTestId?: string;
}

/**
 * How much of the name (in multiples of its font size) the hover overlay must
 * leave uncovered; with less, the actions move to a second line (#4972).
 */
export const NAME_STUB_EM = 4;

/**
 * The width the row's actions take when laid out on one line: their children
 * side by side plus the gaps and leading padding of the actions container.
 * Summed from the children so the result does not depend on whether the
 * container is currently an overlay or a full-width second line.
 */
function actionsWidth(actions: HTMLElement): number {
  const style = getComputedStyle(actions);
  const gap = parseFloat(style.columnGap) || 0;
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const children = Array.from(actions.children) as HTMLElement[];
  const content = children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
  return content + gap * Math.max(0, children.length - 1) + padding;
}

/**
 * Whether the hover overlay would cover the name down to less than a readable
 * stub (#4972): the name starts at `nameLeft` inside the header, and the
 * overlay takes `actions` px off the header's trailing edge. The stub is the
 * smaller of {@link NAME_STUB_EM} and the whole (short) name.
 */
export function overlayCoversName(m: {
  header: number;
  nameLeft: number;
  nameContent: number;
  fontSize: number;
  actions: number;
}): boolean {
  if (m.header <= 0 || m.actions <= 0) return false;
  const stub = Math.min(m.nameContent, NAME_STUB_EM * m.fontSize);
  return m.nameLeft + stub + m.actions > m.header;
}

/**
 * The shared sidebar list-item shell: status dot / badge / name / actions /
 * details. Management sidebars (services and workspaces today; tunnels to
 * follow) compose from this so rows share one structure, hover behaviour, and
 * token'd styling rather than each hand-rolling a bespoke `*-item` block. The
 * shell owns the badge styling — pass badge content, not a class. Forwards its
 * ref and any extra `div` props so it can serve as a Radix
 * `ContextMenu.Trigger asChild`.
 */
export const SidebarListItem = React.forwardRef<HTMLDivElement, SidebarListItemProps>(
  function SidebarListItem(
    {
      name,
      nameTestId,
      nameTooltip,
      actions,
      status,
      badge,
      badgeTestId,
      details,
      testId,
      className,
      error = false,
      actionsVisible = false,
      description,
      descriptionTestId,
      tooltip,
      tooltipTestId,
      ...rest
    },
    ref
  ) {
    const headerRef = useRef<HTMLDivElement | null>(null);
    const [stacked, setStacked] = useState(false);
    const hasActions = actions != null;

    // Decide between the overlay and the second-line layout (#4972). Every
    // input is the same whether or not the row is hovered, so revealing the
    // actions never flips the decision (no flicker under the pointer).
    const measure = useCallback(() => {
      const header = headerRef.current;
      const actionsEl = header?.querySelector<HTMLElement>(".sidebar-list-item__actions");
      const nameEl = header?.querySelector<HTMLElement>(".sidebar-list-item__name");
      if (!header || !actionsEl || !nameEl || error || actionsVisible) {
        setStacked(false);
        return;
      }
      setStacked(
        overlayCoversName({
          header: header.clientWidth,
          nameLeft: nameEl.offsetLeft,
          nameContent: nameEl.scrollWidth,
          fontSize: parseFloat(getComputedStyle(nameEl).fontSize) || 0,
          actions: actionsWidth(actionsEl),
        })
      );
    }, [error, actionsVisible]);

    // Re-measure after every render: the action set changes with the row's
    // state (a running tunnel has more actions than a stopped one).
    useLayoutEffect(() => {
      measure();
    });

    // And whenever the row or its actions change size (sidebar resize).
    useLayoutEffect(() => {
      const header = headerRef.current;
      if (!header || !hasActions || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => measure());
      observer.observe(header);
      const actionsEl = header.querySelector(".sidebar-list-item__actions");
      if (actionsEl) observer.observe(actionsEl);
      return () => observer.disconnect();
    }, [hasActions, measure]);

    const classes = [
      "sidebar-list-item",
      error ? "sidebar-list-item--error" : "",
      actionsVisible ? "sidebar-list-item--actions-visible" : "",
      stacked ? "sidebar-list-item--stacked-actions" : "",
      className ?? "",
    ]
      .filter(Boolean)
      .join(" ");

    const tooltipLines = (tooltip ?? []).filter((line) => line.trim() !== "");
    const shownDescription = description?.trim() ? description.trim() : null;
    const nameEl =
      tooltipLines.length > 0 ? (
        <Tooltip
          side="bottom"
          align="start"
          data-testid={tooltipTestId}
          content={
            <span className="sidebar-list-item__tooltip">
              <span className="sidebar-list-item__tooltip-name">{nameTooltip ?? name}</span>
              {tooltipLines.map((line, i) => (
                <span className="sidebar-list-item__tooltip-line" key={i}>
                  {line}
                </span>
              ))}
            </span>
          }
        >
          <span className="sidebar-list-item__name ui-truncate" data-testid={nameTestId}>
            {name}
          </span>
        </Tooltip>
      ) : (
        <TruncatedText
          className="sidebar-list-item__name"
          data-testid={nameTestId}
          tooltip={nameTooltip}
        >
          {name}
        </TruncatedText>
      );

    return (
      <div
        ref={ref}
        className={classes}
        data-testid={testId}
        aria-description={rowTooltipDescription(tooltipLines)}
        {...rest}
      >
        <div ref={headerRef} className="sidebar-list-item__header">
          {status}
          {badge != null && (
            <span className="sidebar-list-item__badge" data-testid={badgeTestId}>
              {badge}
            </span>
          )}
          {nameEl}
          {actions != null && <div className="sidebar-list-item__actions">{actions}</div>}
        </div>
        {(shownDescription || details) && (
          <div className="sidebar-list-item__details">
            {shownDescription ? (
              <TruncatedText
                className="sidebar-list-item__description"
                data-testid={descriptionTestId}
              >
                {shownDescription}
              </TruncatedText>
            ) : null}
            {details}
          </div>
        )}
      </div>
    );
  }
);
