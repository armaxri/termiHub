import { LayoutConfig } from "@/types/connection";
import "./LayoutPreview.css";

interface LayoutPreviewProps {
  layout: LayoutConfig;
}

/** Larger labeled schematic showing the current layout arrangement. */
export function LayoutPreview({ layout }: LayoutPreviewProps) {
  const abPos = layout.activityBarPosition;
  const sbPos = layout.sidebarPosition;
  const sbVisible = layout.sidebarVisible;
  const statusVisible = layout.statusBarVisible;

  const abIsTop = abPos === "top";
  const abIsHidden = abPos === "hidden";

  return (
    <div className="layout-preview" data-testid="layout-preview">
      {abIsTop && (
        <div className="layout-preview__activity-bar--top">
          <span className="layout-preview__label">Activity Bar</span>
        </div>
      )}
      <div className="layout-preview__main">
        {!abIsTop && !abIsHidden && abPos === "left" && (
          <div className="layout-preview__activity-bar">
            <span className="layout-preview__label">AB</span>
          </div>
        )}
        {sbVisible && sbPos === "left" && (
          <div className="layout-preview__sidebar">
            <span className="layout-preview__label">Sidebar</span>
          </div>
        )}
        <div className="layout-preview__terminal">
          <span className="layout-preview__label">Terminal</span>
        </div>
        {sbVisible && sbPos === "right" && (
          <div className="layout-preview__sidebar">
            <span className="layout-preview__label">Sidebar</span>
          </div>
        )}
        {!abIsTop && !abIsHidden && abPos === "right" && (
          <div className="layout-preview__activity-bar">
            <span className="layout-preview__label">AB</span>
          </div>
        )}
      </div>
      {statusVisible && (
        <div className="layout-preview__status-bar">
          <span className="layout-preview__label">Status Bar</span>
        </div>
      )}
    </div>
  );
}
