import { useId } from "react";
import type React from "react";
import { ChevronRight } from "lucide-react";

import { ICON_SIZE } from "@/components/ui/iconSize";
/** Props of {@link EditorSection}. */
export interface EditorSectionProps {
  title: string;
  /** What the section holds, in a few words; shown beside the title. */
  summary?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  "data-testid"?: string;
}

/** A section of the automation editor that shows its content on demand (#5818). */
export function EditorSection({
  title,
  summary,
  open,
  onOpenChange,
  children,
  "data-testid": testId,
}: EditorSectionProps) {
  const contentId = useId();
  return (
    <section className="automation-editor__section">
      <h3 className="automation-editor__section-heading">
        <button
          type="button"
          className="automation-editor__section-toggle"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          onClick={() => onOpenChange(!open)}
          data-testid={testId}
        >
          <ChevronRight
            size={ICON_SIZE.sm}
            className={
              open
                ? "automation-step__chevron automation-step__chevron--open"
                : "automation-step__chevron"
            }
            aria-hidden="true"
          />
          <span className="automation-editor__section-title">{title}</span>
          {summary && <span className="automation-editor__section-summary">{summary}</span>}
        </button>
      </h3>
      {open && (
        <div id={contentId} className="automation-editor__section-content">
          {children}
        </div>
      )}
    </section>
  );
}
