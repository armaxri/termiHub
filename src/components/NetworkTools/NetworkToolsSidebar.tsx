import { useCallback, useEffect } from "react";
import "./NetworkTools.css";
import { Play, RefreshCw, Plus, Circle, StopCircle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { networkHttpMonitorList, networkHttpMonitorStop } from "@/services/networkApi";
import type { NetworkTool } from "@/types/terminal";
import type { HttpMonitorState } from "@/types/network";
import { frontendLog } from "@/utils/frontendLog";

interface QuickActionProps {
  label: string;
  tool: NetworkTool;
}

function QuickAction({ label, tool }: QuickActionProps) {
  const openNetworkDiagnosticTab = useAppStore((s) => s.openNetworkDiagnosticTab);
  return (
    <button
      className="network-sidebar__action"
      onClick={() => openNetworkDiagnosticTab(tool)}
      data-testid={`network-quick-action-${tool}`}
    >
      <Play size={12} />
      {label}
    </button>
  );
}

interface MonitorRowProps {
  monitor: HttpMonitorState;
  onStop: (id: string) => void;
  onOpen: (id: string) => void;
}

function MonitorRow({ monitor, onStop, onOpen }: MonitorRowProps) {
  const { config, running, lastResult } = monitor;
  const shortUrl = config.url.replace(/^https?:\/\//, "").slice(0, 24);

  return (
    <div className="network-sidebar__monitor" data-testid={`monitor-row-${config.id}`}>
      <div className="network-sidebar__monitor-info" onClick={() => onOpen(config.id)}>
        <Circle
          size={8}
          fill={
            running
              ? lastResult?.ok
                ? "var(--vscode-charts-green)"
                : "var(--vscode-charts-red)"
              : "var(--vscode-disabledForeground)"
          }
          color="transparent"
        />
        <span className="network-sidebar__monitor-url">{shortUrl}</span>
        {lastResult && (
          <span className="network-sidebar__monitor-status">
            {lastResult.ok ? `${lastResult.statusCode} · ${lastResult.latencyMs}ms` : "✗ down"}
          </span>
        )}
        {!lastResult && running && (
          <span className="network-sidebar__monitor-status">checking…</span>
        )}
      </div>
      {running && (
        <button
          className="network-sidebar__monitor-stop"
          title="Stop monitor"
          onClick={() => onStop(config.id)}
        >
          <StopCircle size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * Sidebar panel for the Network Tools activity bar entry.
 *
 * Shows quick-action launchers, running HTTP monitors, and local utilities.
 */
export function NetworkToolsSidebar() {
  const httpMonitors = useAppStore((s) => s.httpMonitors);
  const setHttpMonitors = useAppStore((s) => s.setHttpMonitors);
  const openNetworkDiagnosticTab = useAppStore((s) => s.openNetworkDiagnosticTab);

  // Load monitors on mount.
  const refreshMonitors = useCallback(async () => {
    try {
      const monitors = await networkHttpMonitorList();
      setHttpMonitors(monitors);
    } catch (err) {
      frontendLog("network_sidebar", `Failed to load monitors: ${err}`);
    }
  }, [setHttpMonitors]);

  useEffect(() => {
    void refreshMonitors();
  }, [refreshMonitors]);

  const handleStopMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorStop(id);
        await refreshMonitors();
      } catch (err) {
        frontendLog("network_sidebar", `Failed to stop monitor: ${err}`);
      }
    },
    [refreshMonitors]
  );

  const handleOpenMonitor = useCallback(
    (_id: string) => {
      openNetworkDiagnosticTab("http-monitor");
    },
    [openNetworkDiagnosticTab]
  );

  return (
    <div className="network-sidebar" data-testid="network-tools-sidebar">
      {/* Quick Actions */}
      <div className="network-sidebar__section">
        <div className="network-sidebar__section-title">Quick Actions</div>
        <QuickAction label="Ping Host…" tool="ping" />
        <QuickAction label="Scan Ports…" tool="port-scanner" />
        <QuickAction label="DNS Lookup…" tool="dns-lookup" />
        <QuickAction label="Wake-on-LAN…" tool="wol" />
      </div>

      {/* HTTP Monitors */}
      <div className="network-sidebar__section">
        <div className="network-sidebar__section-title">
          Monitors
          <button
            className="network-sidebar__refresh"
            title="Refresh monitors"
            onClick={refreshMonitors}
          >
            <RefreshCw size={11} />
          </button>
        </div>
        {httpMonitors.length === 0 && (
          <span className="network-sidebar__empty">No monitors running</span>
        )}
        {httpMonitors.map((m) => (
          <MonitorRow
            key={m.config.id}
            monitor={m}
            onStop={handleStopMonitor}
            onOpen={handleOpenMonitor}
          />
        ))}
        <button
          className="network-sidebar__add"
          onClick={() => openNetworkDiagnosticTab("http-monitor")}
          data-testid="network-new-monitor"
        >
          <Plus size={12} />
          New Monitor
        </button>
      </div>

      {/* Local Utilities */}
      <div className="network-sidebar__section">
        <div className="network-sidebar__section-title">Local</div>
        <QuickAction label="View Open Ports" tool="open-ports" />
        <QuickAction label="Traceroute…" tool="traceroute" />
      </div>
    </div>
  );
}
