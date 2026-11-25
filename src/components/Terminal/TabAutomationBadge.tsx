import { Hand, ListVideo } from "lucide-react";
import { Tooltip } from "@/components/ui";
import { runningAutomationLabel, type RunningAutomationInfo } from "@/utils/automationTabBadge";

/** Props for {@link TabAutomationBadge}. */
export interface TabAutomationBadgeProps {
  /** The tab the badge sits on (for its test id). */
  tabId: string;
  /** The running automation on that tab. */
  info: RunningAutomationInfo;
  /** Stop the automation on this tab. */
  onStop?: () => void;
}

/**
 * The one "running automation" badge on a tab (#5818, slice 5): it names the
 * automation and its progress, and a click stops the run on this terminal
 * only. Not a nested button (a focusable control inside `role="tab"` is
 * invalid, A11Y2-011): a labelled image, clickable with the pointer; keyboard
 * users stop it through the tab's context menu ("Stop automation").
 */
export function TabAutomationBadge({ tabId, info, onStop }: TabAutomationBadgeProps) {
  const label = runningAutomationLabel(info);
  return (
    <Tooltip content={onStop ? `${label}. Click to stop it here.` : label} side="bottom">
      <span
        className="tab__automation-badge"
        role="img"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onStop?.();
        }}
        data-testid={`tab-automation-badge-${tabId}`}
      >
        {info.waiting ? <Hand size={12} aria-hidden /> : <ListVideo size={12} aria-hidden />}
        <span className="tab__automation-progress" aria-hidden>
          {info.waiting ? "waits" : info.progress}
        </span>
      </span>
    </Tooltip>
  );
}
