import { CircleDot } from "lucide-react";
import { Tooltip } from "@/components/ui";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./Recording.css";

/** Props of {@link TabRecordingBadge}. */
export interface TabRecordingBadgeProps {
  tabId: string;
  onStop?: () => void;
}

/**
 * Marks the tab whose input is recorded (#5818, slice 8). Like the running
 * automation's badge: a labelled image inside the tab, clickable with the
 * pointer; the keyboard stops it in the toolbar, the sidebar or the tab's menu.
 */
export function TabRecordingBadge({ tabId, onStop }: TabRecordingBadgeProps) {
  return (
    <Tooltip content="Recording what you type here. Click to stop." side="bottom">
      <span
        className="tab__recording-badge"
        role="img"
        aria-label="Recording what you type here"
        onClick={(e) => {
          e.stopPropagation();
          onStop?.();
        }}
        data-testid={`tab-recording-badge-${tabId}`}
      >
        <CircleDot size={ICON_SIZE.xs} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
