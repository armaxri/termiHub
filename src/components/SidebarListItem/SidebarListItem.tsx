import React from "react";
import "./SidebarListItem.css";

/** Semantic tone for a {@link SidebarStatusDot}, mapped to a design token. */
export type SidebarStatusTone = "neutral" | "success" | "warning" | "error";

/** Props for {@link SidebarStatusDot}. */
export interface SidebarStatusDotProps {
  /** Colour tone of the dot. */
  tone: SidebarStatusTone;
  /** Test hook forwarded to the dot element. */
  testId?: string;
  /** Optional extra class (e.g. a per-status test class kept for compatibility). */
  className?: string;
}

/**
 * A small coloured status dot for sidebar rows. Colours come from design tokens
 * via the `--tone` modifier so every sidebar renders the same status affordance.
 */
export function SidebarStatusDot({
  tone,
  testId,
  className,
}: SidebarStatusDotProps): React.ReactElement {
  const classes = [
    "sidebar-list-item__status",
    `sidebar-list-item__status--${tone}`,
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={classes} data-testid={testId} />;
}

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
  /** Action controls (compose from the shared Button primitive). Revealed on hover/focus. */
  actions: React.ReactNode;
  /** Optional leading status indicator (typically a {@link SidebarStatusDot}). */
  status?: React.ReactNode;
  /** Optional badge shown next to the name (e.g. a protocol/type tag). */
  badge?: React.ReactNode;
  /** Optional detail lines shown beneath the header. */
  details?: React.ReactNode;
  /** Test hook for the row container. */
  testId?: string;
  /** Apply the error modifier (keeps recovery actions visible). */
  error?: boolean;
}

/**
 * The shared sidebar list-item shell: status dot / badge / name / actions /
 * details. Every management sidebar (services, workspaces, tunnels) composes
 * from this so rows share one structure, hover behaviour, and token'd styling
 * rather than each hand-rolling a bespoke `*-item` block. Forwards its ref and
 * any extra `div` props so it can serve as a Radix `ContextMenu.Trigger asChild`.
 */
export const SidebarListItem = React.forwardRef<HTMLDivElement, SidebarListItemProps>(
  function SidebarListItem(
    {
      name,
      nameTestId,
      actions,
      status,
      badge,
      details,
      testId,
      className,
      error = false,
      ...rest
    },
    ref
  ) {
    const classes = ["sidebar-list-item", error ? "sidebar-list-item--error" : "", className ?? ""]
      .filter(Boolean)
      .join(" ");

    return (
      <div ref={ref} className={classes} data-testid={testId} {...rest}>
        <div className="sidebar-list-item__header">
          {status}
          {badge}
          <span className="sidebar-list-item__name" data-testid={nameTestId}>
            {name}
          </span>
          <div className="sidebar-list-item__actions">{actions}</div>
        </div>
        {details && <div className="sidebar-list-item__details">{details}</div>}
      </div>
    );
  }
);
