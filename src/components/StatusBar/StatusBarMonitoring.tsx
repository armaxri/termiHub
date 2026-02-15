import { useEffect, useRef, useCallback } from "react";
import { Activity, RefreshCw, Unplug, Loader2, AlertCircle } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useAppStore } from "@/store/appStore";
import { SshConfig, ConnectionConfig } from "@/types/terminal";
import { SavedConnection } from "@/types/connection";
import "./StatusBarMonitoring.css";

const REFRESH_INTERVAL_MS = 5000;

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

/** Determine color level for a metric percentage. */
function metricLevel(value: number): "normal" | "warning" | "critical" {
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped >= 90) return "critical";
  if (clamped >= 70) return "warning";
  return "normal";
}

/**
 * Status bar monitoring widget.
 *
 * Disconnected: shows a dropdown trigger to pick an SSH connection.
 * Connected: shows compact inline stats (host, CPU, Mem, Disk) with
 * refresh and disconnect buttons.
 */
export function StatusBarMonitoring() {
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

  // --- Connected state: inline stats ---
  if (monitoringSessionId) {
    const stats = monitoringStats;
    return (
      <div className="sb-monitoring" data-testid="statusbar-monitoring">
        <span className="sb-monitoring__host" title={monitoringHost ?? ""}>
          {monitoringHost}
        </span>
        {stats && (
          <>
            <span className="sb-monitoring__separator">|</span>
            <span
              className={`sb-monitoring__metric sb-monitoring__metric--${metricLevel(stats.cpuUsagePercent)}`}
              title={`CPU: ${stats.cpuUsagePercent.toFixed(1)}%`}
            >
              CPU {Math.round(stats.cpuUsagePercent)}%
            </span>
            <span className="sb-monitoring__separator">|</span>
            <span
              className={`sb-monitoring__metric sb-monitoring__metric--${metricLevel(stats.memoryUsedPercent)}`}
              title={`Memory: ${stats.memoryUsedPercent.toFixed(1)}%`}
            >
              Mem {Math.round(stats.memoryUsedPercent)}%
            </span>
            <span className="sb-monitoring__separator">|</span>
            <span
              className={`sb-monitoring__metric sb-monitoring__metric--${metricLevel(stats.diskUsedPercent)}`}
              title={`Disk: ${stats.diskUsedPercent.toFixed(1)}%`}
            >
              Disk {Math.round(stats.diskUsedPercent)}%
            </span>
          </>
        )}
        <button
          className="sb-monitoring__btn"
          onClick={refreshMonitoring}
          disabled={monitoringLoading}
          title="Refresh monitoring"
          aria-label="Refresh monitoring"
          data-testid="statusbar-monitoring-refresh"
        >
          <RefreshCw
            size={12}
            className={monitoringLoading ? "sb-monitoring__spinner" : ""}
          />
        </button>
        <button
          className="sb-monitoring__btn"
          onClick={disconnectMonitoring}
          title="Disconnect monitoring"
          aria-label="Disconnect monitoring"
          data-testid="statusbar-monitoring-disconnect"
        >
          <Unplug size={12} />
        </button>
      </div>
    );
  }

  // --- Disconnected state: dropdown picker ---
  return (
    <div className="sb-monitoring" data-testid="statusbar-monitoring">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="sb-monitoring__trigger"
            disabled={monitoringLoading}
            title={monitoringError ? `Error: ${monitoringError}` : "SSH Monitoring"}
            data-testid="statusbar-monitoring-trigger"
          >
            {monitoringLoading ? (
              <Loader2 size={12} className="sb-monitoring__spinner" />
            ) : monitoringError ? (
              <AlertCircle size={12} className="sb-monitoring__error-icon" />
            ) : (
              <Activity size={12} />
            )}
            <span>Monitor</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="sb-monitoring__dropdown"
            side="top"
            align="start"
            sideOffset={4}
          >
            {sshConnections.length === 0 ? (
              <DropdownMenu.Item className="sb-monitoring__dropdown-item" disabled>
                No SSH connections
              </DropdownMenu.Item>
            ) : (
              sshConnections.map((conn) => (
                <DropdownMenu.Item
                  key={conn.id}
                  className="sb-monitoring__dropdown-item"
                  onSelect={() => handleConnect(conn)}
                  data-testid={`statusbar-monitoring-connect-${conn.id}`}
                >
                  {conn.name}
                </DropdownMenu.Item>
              ))
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
