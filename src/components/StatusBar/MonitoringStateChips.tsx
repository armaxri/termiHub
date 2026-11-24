import { Activity, Info } from "lucide-react";
import { Spinner, Tooltip } from "@/components/ui";
import type { MonitorStatusReason } from "@/types/monitoring";
import { monitorOfflineReasonText, monitorUnsupportedTooltip } from "@/utils/monitorStatusReason";

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

/**
 * Status-bar state while a connected monitor waits for its first reading
 * (#5840): muted "Waiting for stats…", so loading never reads as "off" or "not
 * supported".
 */
export function MonitoringWaiting() {
  return (
    <span
      className="status-bar__item monitoring-status__muted"
      title="Monitoring is on — the first reading from this host is on its way."
      data-testid="monitoring-waiting"
    >
      <Spinner size="xs" label={null} />
      Waiting for stats…
    </span>
  );
}

/** Props for {@link MonitoringUnavailable}. */
export interface MonitoringUnavailableProps {
  /** Why collects are failing, or `null` when the backend gave no reason. */
  reason: MonitorStatusReason | null;
}

/** Tooltip for a host that has not produced a first reading (#5840). */
export function monitoringUnavailableTooltip(reason: MonitorStatusReason | null): string {
  return (
    `This host is not reporting stats (${monitorOfflineReasonText(reason)}). ` +
    "termiHub keeps trying; the terminal session is not affected."
  );
}

/**
 * Status-bar state for a monitor whose collects fail before the first sample
 * (#5840): a muted "Monitoring unavailable" with the reason in the tooltip. It
 * is muted rather than an error because the session itself is fine, and the
 * loop is still retrying; a terminal failure becomes the offline Retry chip.
 */
export function MonitoringUnavailable({ reason }: MonitoringUnavailableProps) {
  const tooltip = monitoringUnavailableTooltip(reason);
  return (
    <span
      className="status-bar__item monitoring-status__muted"
      title={tooltip}
      aria-label={`Monitoring unavailable: ${tooltip}`}
      data-testid="monitoring-unavailable"
      data-reason={reason ?? undefined}
    >
      <Info size={12} />
      Monitoring unavailable
    </span>
  );
}
