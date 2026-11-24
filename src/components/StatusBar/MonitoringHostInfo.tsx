import type { ReactNode } from "react";
import type { SystemStats } from "@/types/monitoring";
import type { StatsMetric } from "@/types/generated/StatsMetric";
import { formatRate } from "@/utils/formatters";
import { isMetricUnavailable, statsSourceLabel } from "./monitoringAvailability";

/** Props for {@link MonitoringHostInfo}. */
interface MonitoringHostInfoProps {
  /** The latest sample of the active monitor. */
  stats: SystemStats;
  /**
   * The name the user knows the host by — the host as configured, which heads
   * the menu (#5840). The host's own resolved hostname is then shown muted, and
   * only when it differs.
   */
  configuredHost?: string | null;
}

/** Placeholder rendered for a metric the sample could not supply (#3202). */
const UNAVAILABLE = "Unavailable";

/** Format seconds into a human-readable uptime string. */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** One label/value row of the host-info block. */
function InfoRow({
  label,
  testId,
  muted = false,
  children,
}: {
  label: string;
  testId: string;
  /** Secondary detail (e.g. the resolved hostname): value in the muted colour. */
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="monitoring-menu__row">
      <span className="monitoring-menu__label">{label}</span>
      <span
        className={`monitoring-menu__value${muted ? " monitoring-menu__value--muted" : ""}`}
        data-testid={testId}
      >
        {children}
      </span>
    </div>
  );
}

/**
 * Host-info block of the monitoring dropdown: resolved hostname, OS, uptime and load, plus
 * — for a Docker-stats-sourced sample (#3202) — the source label, PID count and
 * block I/O. Metrics the sample lists as unavailable render "Unavailable"
 * instead of a misleading zero.
 */
export function MonitoringHostInfo({ stats, configuredHost }: MonitoringHostInfoProps) {
  const source = statsSourceLabel(stats);
  const orUnavailable = (metric: StatsMetric, value: string) =>
    isMetricUnavailable(stats, metric) ? UNAVAILABLE : value;
  const hasBlockIo =
    stats.blockReadBytesPerSec !== undefined && stats.blockWriteBytesPerSec !== undefined;

  return (
    <div className="monitoring-menu__info" data-testid="monitoring-host-info">
      {source && (
        <InfoRow label="Source" testId="monitoring-info-source">
          {source}
        </InfoRow>
      )}
      {/* The menu is headed by the configured host (#5840); the machine's own
          name is a muted detail, left out when it is the same name. */}
      {stats.hostname && stats.hostname !== configuredHost && (
        <InfoRow label="Hostname" testId="monitoring-info-host" muted={!!configuredHost}>
          {stats.hostname}
        </InfoRow>
      )}
      <InfoRow label="OS" testId="monitoring-info-os">
        {orUnavailable("osInfo", stats.osInfo)}
      </InfoRow>
      <InfoRow label="Uptime" testId="monitoring-info-uptime">
        {orUnavailable("uptime", formatUptime(stats.uptimeSeconds))}
      </InfoRow>
      <InfoRow label="Load" testId="monitoring-info-load">
        {orUnavailable("loadAverage", stats.loadAverage.map((v) => v.toFixed(2)).join(" "))}
      </InfoRow>
      {stats.pidsCurrent !== undefined && (
        <InfoRow label="PIDs" testId="monitoring-info-pids">
          {stats.pidsCurrent}
        </InfoRow>
      )}
      {hasBlockIo && (
        <InfoRow label="Block I/O" testId="monitoring-info-block-io">
          {`↓${formatRate(stats.blockReadBytesPerSec ?? 0) || "0 B/s"} ↑${
            formatRate(stats.blockWriteBytesPerSec ?? 0) || "0 B/s"
          }`}
        </InfoRow>
      )}
    </div>
  );
}
