import { Activity, Info, RotateCw, TriangleAlert } from "lucide-react";
import { Spinner, Tooltip } from "@/components/ui";
import type { MonitorStatusReason } from "@/types/monitoring";
import {
  MONITOR_UNSUPPORTED_SHORT,
  monitorOfflineReasonText,
  monitorUnsupportedTooltip,
} from "@/utils/monitorStatusReason";

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

/** Props of the stats-less chips that can be tried again. */
export interface MonitoringRetryProps {
  /** Try monitoring again. */
  onRetry: () => void;
}

/** "Monitoring unavailable · why · Retry": the reason without hovering, and a way on (states-1). */
function UnavailableChip({
  testId,
  reason,
  short,
  tooltip,
  onRetry,
  tone = "muted",
}: MonitoringRetryProps & {
  testId: string;
  reason?: string;
  short: string;
  tooltip: string;
  /**
   * `warning` when something went wrong (collects fail); `muted` for what is so
   * by design, like a host without a stats source (#6183, states-2).
   */
  tone?: "muted" | "warning";
}) {
  return (
    <span
      className="monitoring-status"
      title={tooltip}
      aria-label={`Monitoring unavailable: ${tooltip}`}
      data-testid={testId}
      data-reason={reason}
    >
      <span className="status-bar__item monitoring-status__muted">
        {tone === "warning" ? (
          <TriangleAlert
            size={12}
            className="monitoring-status__warn-icon"
            data-tone="warning"
            data-testid={`${testId}-icon`}
            aria-hidden="true"
          />
        ) : (
          <Info size={12} data-tone="muted" data-testid={`${testId}-icon`} aria-hidden="true" />
        )}
        Monitoring unavailable · {short}
      </span>
      <button
        className="status-bar__item status-bar__item--interactive monitoring-status__muted"
        aria-label="Retry monitoring"
        data-testid={`${testId}-retry`}
        onClick={onRetry}
      >
        <RotateCw size={12} />
        Retry
      </button>
    </span>
  );
}

/**
 * Status-bar state for a host with no stats source (#5471, #5628). It is a
 * capability state, not an error: muted, with the reason in a few words and in
 * the tooltip. Retry stays offered (live review states-1): the host may gain a
 * shell, or the probe may have met a passing failure.
 */
export function MonitoringUnsupported({ onRetry }: MonitoringRetryProps) {
  return (
    <UnavailableChip
      testId="monitoring-unsupported"
      reason="unsupported"
      short={MONITOR_UNSUPPORTED_SHORT}
      tooltip={monitorUnsupportedTooltip()}
      onRetry={onRetry}
    />
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
export interface MonitoringUnavailableProps extends MonitoringRetryProps {
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
 * (#5840): "Monitoring unavailable" with the reason. Its text stays muted, as
 * the session itself is fine and the loop is still retrying, but its icon is a
 * warning, so it does not look like a monitor the user stopped (#6183,
 * states-2); a terminal failure becomes the offline Retry chip.
 */
export function MonitoringUnavailable({ reason, onRetry }: MonitoringUnavailableProps) {
  return (
    <UnavailableChip
      testId="monitoring-unavailable"
      tone="warning"
      reason={reason ?? undefined}
      short={monitorOfflineReasonText(reason)}
      tooltip={monitoringUnavailableTooltip(reason)}
      onRetry={onRetry}
    />
  );
}
