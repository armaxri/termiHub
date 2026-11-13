import type { ReactNode } from "react";
import "./SettingsSectionHeading.css";

/** Shared class of every Settings section heading (#5634). */
export const SETTINGS_SECTION_HEADING_CLASS = "settings-section__heading";

/** Props for {@link SettingsSectionHeading}. */
export interface SettingsSectionHeadingProps {
  /** Heading text, in sentence case. */
  children: ReactNode;
  /** Heading level: `3` for a section of a category (default), `4` when nested. */
  level?: 3 | 4;
  /** Optional element id (e.g. for `aria-labelledby`). */
  id?: string;
  /** Extra class names. */
  className?: string;
  /** Test id; defaults to `settings-section-heading`, which the product run reads. */
  "data-testid"?: string;
}

/**
 * The one section heading every Settings category uses (#5634): the same size,
 * weight, colour, spacing and divider on every page, so the panel no longer
 * mixes a small grey heading on some pages with a large white one on others.
 * Section hints below it use the shared `settings-panel__description` style.
 */
export function SettingsSectionHeading({
  children,
  level = 3,
  id,
  className,
  "data-testid": testId = "settings-section-heading",
}: SettingsSectionHeadingProps) {
  const Tag = level === 4 ? "h4" : "h3";
  const classes = [SETTINGS_SECTION_HEADING_CLASS, className ?? ""].filter(Boolean).join(" ");
  return (
    <Tag id={id} className={classes} data-testid={testId}>
      {children}
    </Tag>
  );
}
