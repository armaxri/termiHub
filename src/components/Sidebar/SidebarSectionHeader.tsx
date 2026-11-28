import React from "react";
import { ChevronRight } from "lucide-react";
import { TruncatedText } from "@/components/ui";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./SidebarSectionHeader.css";

/** The disclosure state of a collapsible section. */
export interface SidebarSectionCollapse {
  /** Whether the section's content shows. */
  expanded: boolean;
  /** Show or hide the content. */
  onToggle: () => void;
  /** Id of the content element, named while it is shown. */
  controls: string;
  /** `data-testid` of the disclosure button. */
  testId?: string;
}

/**
 * Props for {@link SidebarSectionHeader}. The header is a ref-forwarding `header`
 * element so a caller can measure it (e.g. with `useElementWidth`) to drop an
 * optional label from its controls when the sidebar is narrow.
 */
export interface SidebarSectionHeaderProps {
  /** Section title text (sentence case, #5848). */
  title: string;
  /** Optional leading icon (decorative). */
  icon?: React.ReactNode;
  /** Optional suffix shown after the title, truncating with it. */
  suffix?: React.ReactNode;
  /**
   * Make the section collapsible (#5818): the title becomes a disclosure button
   * with a chevron. The section's content is the caller's to render or not.
   */
  collapse?: SidebarSectionCollapse;
  /** Trailing controls. They never shrink, wrap or clip. */
  actions?: React.ReactNode;
  /** `data-testid` of the header element. */
  "data-testid"?: string;
}

/**
 * The in-sidebar section header (#4709) shared by the History and Schedules
 * sections: a sentence-case title that takes the leftover width and ellipsizes
 * (full title in a tooltip), followed by controls that keep their size. The
 * title never wraps and the controls never clip, whatever the sidebar width.
 */
export const SidebarSectionHeader = React.forwardRef<HTMLElement, SidebarSectionHeaderProps>(
  function SidebarSectionHeader(
    { title, icon, suffix, collapse, actions, "data-testid": testId },
    ref
  ) {
    const text =
      suffix != null ? (
        <>
          {title}
          {suffix}
        </>
      ) : (
        title
      );
    const label = (
      <>
        {icon}
        <TruncatedText className="sidebar-section-header__text">{text}</TruncatedText>
      </>
    );
    return (
      <header ref={ref} className="sidebar-section-header" data-testid={testId}>
        {collapse ? (
          <button
            type="button"
            className="ui-section-label sidebar-section-header__title sidebar-section-header__toggle"
            aria-expanded={collapse.expanded}
            aria-controls={collapse.expanded ? collapse.controls : undefined}
            onClick={collapse.onToggle}
            data-testid={collapse.testId}
          >
            <ChevronRight
              size={ICON_SIZE.xs}
              aria-hidden="true"
              className={
                collapse.expanded
                  ? "sidebar-section-header__chevron sidebar-section-header__chevron--open"
                  : "sidebar-section-header__chevron"
              }
            />
            {label}
          </button>
        ) : (
          <span className="ui-section-label sidebar-section-header__title">{label}</span>
        )}
        {actions != null && <span className="sidebar-section-header__actions">{actions}</span>}
      </header>
    );
  }
);
