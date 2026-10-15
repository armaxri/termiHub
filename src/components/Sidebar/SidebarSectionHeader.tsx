import React from "react";
import { TruncatedText } from "@/components/ui";
import "./SidebarSectionHeader.css";

/**
 * Props for {@link SidebarSectionHeader}. The header is a ref-forwarding `header`
 * element so a caller can measure it (e.g. with `useElementWidth`) to drop an
 * optional label from its controls when the sidebar is narrow.
 */
export interface SidebarSectionHeaderProps {
  /** Section title text (rendered uppercased via CSS). */
  title: string;
  /** Optional leading icon (decorative). */
  icon?: React.ReactNode;
  /** Optional suffix shown after the title, truncating with it. */
  suffix?: React.ReactNode;
  /** Trailing controls. They never shrink, wrap or clip. */
  actions?: React.ReactNode;
  /** `data-testid` of the header element. */
  "data-testid"?: string;
}

/**
 * The in-sidebar section header (#4709) shared by the History and Schedules
 * sections: an uppercase title that takes the leftover width and ellipsizes
 * (full title in a tooltip), followed by controls that keep their size. The
 * title never wraps and the controls never clip, whatever the sidebar width.
 */
export const SidebarSectionHeader = React.forwardRef<HTMLElement, SidebarSectionHeaderProps>(
  function SidebarSectionHeader({ title, icon, suffix, actions, "data-testid": testId }, ref) {
    const text =
      suffix != null ? (
        <>
          {title}
          {suffix}
        </>
      ) : (
        title
      );
    return (
      <header ref={ref} className="sidebar-section-header" data-testid={testId}>
        <span className="sidebar-section-header__title">
          {icon}
          <TruncatedText className="sidebar-section-header__text">{text}</TruncatedText>
        </span>
        {actions != null && <span className="sidebar-section-header__actions">{actions}</span>}
      </header>
    );
  }
);
