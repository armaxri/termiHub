import { useEffect, useRef, useCallback } from "react";
import { RefreshCw, Unplug, Loader2, AlertCircle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { SshConfig, ConnectionConfig } from "@/types/terminal";
import { SavedConnection } from "@/types/connection";
import { SystemStats } from "@/types/monitoring";
import "./MonitoringPanel.css";

/** Format seconds into a human-readable uptime string. */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Format kB into a human-readable size. */
function formatKb(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / (1024 * 1024)).toFixed(1)} GB`;
}

/** Extract SshConfig from a saved connection, if it's SSH type. */
function extractSshConfig(config: ConnectionConfig): SshConfig | null {
  if (config.type === "ssh") return config.config;
  return null;
}

/** Get all SSH connections from the store. */
function useSshConnections(): SavedConnection[] {
  const connections = useAppStore((s) => s.connections);
  const externalSources = useAppStore((s) => s.externalSources);

  const sshConnections: SavedConnection[] = [];
  for (const c of connections) {
    if (c.config.type === "ssh") sshConnections.push(c);
  }
  for (const source of externalSources) {
    for (const c of source.connections) {
      if (c.config.type === "ssh") sshConnections.push(c);
    }
  }
  return sshConnections;
}

interface ProgressBarProps {
  label: string;
  value: number;
  detail: string;
}

/** A labeled progress bar showing a percentage. */
function ProgressBar({ label, value, detail }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const level = clamped >= 90 ? "critical" : clamped >= 70 ? "warning" : "normal";

  return (
    <div className="monitoring__metric">
      <div className="monitoring__metric-header">
        <span className="monitoring__metric-label">{label}</span>
        <span className="monitoring__metric-value">{clamped.toFixed(1)}%</span>
      </div>
      <div className="monitoring__progress-track">
        <div
          className={`monitoring__progress-fill monitoring__progress-fill--${level}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="monitoring__metric-detail">{detail}</span>
    </div>
  );
}

interface StatsDisplayProps {
  stats: SystemStats;
}

/** Display all system stats. */
function StatsDisplay({ stats }: StatsDisplayProps) {
  const memUsedKb = stats.memoryTotalKb - stats.memoryAvailableKb;

  return (
    <div className="monitoring__stats">
      <div className="monitoring__info-row">
        <span className="monitoring__info-label">Host</span>
        <span className="monitoring__info-value">{stats.hostname}</span>
      </div>
      <div className="monitoring__info-row">
        <span className="monitoring__info-label">OS</span>
        <span className="monitoring__info-value">{stats.osInfo}</span>
      </div>
      <div className="monitoring__info-row">
        <span className="monitoring__info-label">Uptime</span>
        <span className="monitoring__info-value">{formatUptime(stats.uptimeSeconds)}</span>
      </div>
      <div className="monitoring__info-row">
        <span className="monitoring__info-label">Load</span>
        <span className="monitoring__info-value">
          {stats.loadAverage.map((v) => v.toFixed(2)).join(" ")}
        </span>
      </div>

      <div className="monitoring__separator" />

      <ProgressBar
        label="CPU"
        value={stats.cpuUsagePercent}
        detail={`Load avg: ${stats.loadAverage[0].toFixed(2)}`}
      />

      <ProgressBar
        label="Memory"
        value={stats.memoryUsedPercent}
        detail={`${formatKb(memUsedKb)} / ${formatKb(stats.memoryTotalKb)}`}
      />

      <ProgressBar
        label="Disk /"
        value={stats.diskUsedPercent}
        detail={`${formatKb(stats.diskUsedKb)} / ${formatKb(stats.diskTotalKb)}`}
      />
    </div>
  );
}

const REFRESH_INTERVAL_MS = 5000;

/**
 * SSH Remote Monitoring Panel.
 *
 * Shows a connection picker when disconnected, and live system stats
 * with auto-refresh when connected.
 */
export function MonitoringPanel() {
  const monitoringSessionId = useAppStore((s) => s.monitoringSessionId);
  const monitoringHost = useAppStore((s) => s.monitoringHost);
  const monitoringStats = useAppStore((s) => s.monitoringStats);
  const monitoringLoading = useAppStore((s) => s.monitoringLoading);
  const monitoringError = useAppStore((s) => s.monitoringError);
  const connectMonitoring = useAppStore((s) => s.connectMonitoring);
  const disconnectMonitoring = useAppStore((s) => s.disconnectMonitoring);
  const refreshMonitoring = useAppStore((s) => s.refreshMonitoring);

  const sshConnections = useSshConnections();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-refresh polling
  useEffect(() => {
    if (monitoringSessionId) {
      intervalRef.current = setInterval(() => {
        refreshMonitoring();
      }, REFRESH_INTERVAL_MS);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [monitoringSessionId, refreshMonitoring]);

  const handleConnect = useCallback(
    (connection: SavedConnection) => {
      const sshConfig = extractSshConfig(connection.config);
      if (sshConfig) {
        connectMonitoring(sshConfig);
      }
    },
    [connectMonitoring]
  );

  // --- Disconnected state: show connection picker ---
  if (!monitoringSessionId) {
    return (
      <div className="monitoring" data-testid="monitoring-panel">
        {monitoringLoading && (
          <div className="monitoring__loading">
            <Loader2 size={20} className="monitoring__spinner" />
            Connecting...
          </div>
        )}

        {monitoringError && (
          <div className="monitoring__error">
            <AlertCircle size={14} />
            <span>{monitoringError}</span>
          </div>
        )}

        {!monitoringLoading && (
          <div className="monitoring__picker">
            <span className="monitoring__picker-label">Select an SSH connection to monitor:</span>
            {sshConnections.length === 0 && (
              <span className="monitoring__picker-empty">No SSH connections configured.</span>
            )}
            {sshConnections.map((conn) => (
              <button
                key={conn.id}
                className="monitoring__picker-btn"
                onClick={() => handleConnect(conn)}
                data-testid={`monitoring-connect-${conn.id}`}
              >
                {conn.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // --- Connected state: show stats ---
  return (
    <div className="monitoring" data-testid="monitoring-panel">
      <div className="monitoring__toolbar">
        <span className="monitoring__host" title={monitoringHost ?? ""}>
          {monitoringHost}
        </span>
        <div className="monitoring__actions">
          <button
            className="monitoring__btn"
            onClick={refreshMonitoring}
            disabled={monitoringLoading}
            title="Refresh"
            aria-label="Refresh monitoring"
            data-testid="monitoring-refresh"
          >
            <RefreshCw size={14} className={monitoringLoading ? "monitoring__spinner" : ""} />
          </button>
          <button
            className="monitoring__btn"
            onClick={disconnectMonitoring}
            title="Disconnect"
            aria-label="Disconnect monitoring"
            data-testid="monitoring-disconnect"
          >
            <Unplug size={14} />
          </button>
        </div>
      </div>

      {monitoringError && (
        <div className="monitoring__error">
          <AlertCircle size={14} />
          <span>{monitoringError}</span>
        </div>
      )}

      {monitoringStats && <StatsDisplay stats={monitoringStats} />}
    </div>
  );
}
