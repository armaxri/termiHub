import { LayoutConfig } from "@/types/connection";
import "./LayoutPreview.css";

interface LayoutPreviewProps {
  layout: LayoutConfig;
}

/** Live miniature schematic of the current layout configuration. */
export function LayoutPreview({ layout }: LayoutPreviewProps) {
  const abPos = layout.activityBarPosition;
  const sbPos = layout.sidebarPosition;
  const sbVisible = layout.sidebarVisible;
  const statusVisible = layout.statusBarVisible;

  const abIsTop = abPos === "top";
  const abIsHidden = abPos === "hidden";

  const activityBar = (
    <div className="layout-preview__activity-bar" data-testid="preview-ab">
      <span className="layout-preview__label">AB</span>
    </div>
  );

  const sidebar = (
    <div className="layout-preview__sidebar" data-testid="preview-sidebar">
      <span className="layout-preview__label">Sidebar</span>
    </div>
  );

  const terminal = (
    <div className="layout-preview__terminal" data-testid="preview-terminal">
      <span className="layout-preview__label">Terminal</span>
    </div>
  );

  const contentRow = (
    <div className="layout-preview__content" data-testid="preview-content">
      {!abIsTop && !abIsHidden && abPos === "left" && activityBar}
      {sbVisible && sbPos === "left" && sidebar}
      {terminal}
      {sbVisible && sbPos === "right" && sidebar}
      {!abIsTop && !abIsHidden && abPos === "right" && activityBar}
    </div>
  );

  return (
    <div className="layout-preview" data-testid="layout-preview">
      {abIsTop && (
        <div className="layout-preview__activity-bar--top" data-testid="preview-ab-top">
          <span className="layout-preview__label">Activity Bar</span>
        </div>
      )}
      {abIsTop ? (
        contentRow
      ) : (
        <div className="layout-preview__main" data-testid="preview-main">
          {!abIsHidden && abPos === "left" && activityBar}
          {sbVisible && sbPos === "left" && sidebar}
          {terminal}
          {sbVisible && sbPos === "right" && sidebar}
          {!abIsHidden && abPos === "right" && activityBar}
        </div>
      )}
      {statusVisible && (
        <div className="layout-preview__status-bar" data-testid="preview-statusbar">
          <span className="layout-preview__label">Status Bar</span>
        </div>
      )}
    </div>
  );
}
