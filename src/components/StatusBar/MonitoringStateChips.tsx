import { Activity, Info } from "lucide-react";
import { Tooltip } from "@/components/ui";
import { monitorUnsupportedTooltip } from "@/utils/monitorStatusReason";

/** Props for {@link MonitoringStopped}. */
export interface MonitoringStoppedProps {
  /** Restart monitoring for the active tab. */
  onStart: () => void;
}

/**
 * Status-bar state after the user stopped monitoring from the host menu
 * (#5628): every metric chip is gone and one muted `Monitoring off · Start monitoring`
 * button restarts it, so a stopped monitor never shows stale numbers. The verb
 * pairs with the menu's "Stop monitoring" item (#5750).
 */
export function MonitoringStopped({ onStart }: MonitoringStoppedProps) {
  return (
    <span className="monitoring-status" data-testid="monitoring-stopped">
      <Tooltip content="Monitoring is off for this tab — click to start it again" side="top">
        <button
          className="status-bar__item status-bar__item--interactive monitoring-status__muted"
          aria-label="Monitoring off — start monitoring"
          data-testid="monitoring-start-btn"
          onClick={onStart}
        >
          <Activity size={12} />
          Monitoring off
          <span className="monitoring-status__action">· Start monitoring</span>
        </button>
      </Tooltip>
    </span>
  );
}

/**
 * Status-bar state for a host with no stats source (#5471, #5628). It is a
 * permanent capability state, not an error: muted text with an info icon and a
 * tooltip explaining why, and no Retry.
 */
export function MonitoringUnsupported() {
  const reason = monitorUnsupportedTooltip();
  return (
    <span
      className="status-bar__item monitoring-status__muted"
      title={reason}
      aria-label={`Monitoring unavailable: ${reason}`}
      data-testid="monitoring-unsupported"
      data-reason="unsupported"
    >
      <Info size={12} />
      Monitoring unavailable
    </span>
  );
}
