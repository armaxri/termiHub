import type { KeyboardEventHandler, ReactNode, RefObject, FocusEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { TOAST_AVOID_FORM_PROPS, TOAST_AVOID_PROPS } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import "./ServiceEditor.css";

interface ServiceEditorShellProps {
  testId: string;
  isVisible: boolean;
  /** What the user wants to do, or the name of what is edited. */
  title: string;
  /** The technical name. */
  subtitle: ReactNode;
  /** Shows the kinds, while they do not show. */
  onChangeType?: () => void;
  /** Marks the fields, see `useRevealOnSave`. */
  rootProps: { ref: RefObject<HTMLDivElement>; onBlurCapture: (event: FocusEvent) => void };
  onKeyDown: KeyboardEventHandler;
  /** Why it cannot be saved yet, or what Save will do. */
  note?: string;
  /** Cancel, Save and Save and start, in this order. */
  actions: ReactNode;
  children: ReactNode;
}

/**
 * The one style of the service editors (#6028, slices 7 and 8): what it is for on
 * top, the fields in between, and Save always on screen, with the reason beside it
 * while it cannot save.
 */
export function ServiceEditorShell({
  testId,
  isVisible,
  title,
  subtitle,
  onChangeType,
  rootProps,
  onKeyDown,
  note,
  actions,
  children,
}: ServiceEditorShellProps) {
  return (
    <div
      className={`service-editor ${isVisible ? "" : "service-editor--hidden"}`}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      <div className="service-editor__header">
        <h2 className="service-editor__title" data-testid={`${testId}-title`}>
          {title}
        </h2>
        <p className="service-editor__subtitle">
          {subtitle}
          {onChangeType && (
            <>
              {" "}
              <button
                type="button"
                className="service-editor__link"
                onClick={onChangeType}
                data-testid={`${testId}-change-type`}
              >
                {t("service.editor.changeType")}
              </button>
            </>
          )}
        </p>
      </div>
      <div
        className="service-editor__form"
        data-testid={`${testId}-form`}
        {...rootProps}
        {...TOAST_AVOID_FORM_PROPS}
      >
        <div className="service-editor__fields">{children}</div>
      </div>
      <div className="service-editor__footer">
        <div
          className="service-editor__actions"
          data-testid={`${testId}-actions`}
          {...TOAST_AVOID_PROPS}
        >
          <span className="service-editor__note" data-testid={`${testId}-note`}>
            {note}
          </span>
          {actions}
        </div>
      </div>
    </div>
  );
}

/** "New service · Web server (HTTP)", or what a saved one is. */
export function editorSubtitle(isNew: boolean, technical: string): string {
  return isNew ? tf("service.editor.new", { technical }) : technical;
}

/** What the user should know before saving, beside the field it is about. */
export function ServiceEditorWarning({
  testId,
  children,
}: {
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="service-editor__warning" role="status" data-testid={testId}>
      <AlertTriangle size={14} aria-hidden="true" className="service-editor__warning-icon" />
      <span>{children}</span>
    </div>
  );
}
