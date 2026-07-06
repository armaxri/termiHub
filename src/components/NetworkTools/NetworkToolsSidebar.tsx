import { useCallback, useEffect } from "react";
import "./NetworkTools.css";
import { Play, RefreshCw, Plus, Circle, StopCircle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import {
  networkHttpMonitorList,
  networkHttpMonitorStop,
  onHttpMonitorCheck,
} from "@/services/networkApi";
import type { NetworkTool } from "@/types/terminal";
import type { HttpMonitorState } from "@/types/network";
import { frontendLog } from "@/utils/frontendLog";
import { Button, Tooltip } from "@/components/ui";

interface QuickActionProps {
  label: string;
  tool: NetworkTool;
}

function QuickAction({ label, tool }: QuickActionProps) {
  const openNetworkDiagnosticTab = useAppStore((s) => s.openNetworkDiagnosticTab);
  return (
    <Button
      variant="ghost"
      size="sm"
      fullWidth
      className="network-sidebar__list-btn"
      icon={<Play size={12} />}
      onClick={() => openNetworkDiagnosticTab(tool)}
      data-testid={`network-quick-action-${tool}`}
    >
      {label}
    </Button>
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
        <Tooltip content="Stop monitor" side="left">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Stop monitor"
            icon={<StopCircle size={12} />}
            onClick={() => onStop(config.id)}
          />
        </Tooltip>
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

  // Stay live: a monitor started while the sidebar is already mounted emits
  // `network-http-monitor-check` events (the first fires immediately on start).
  // Refetch on every check so a newly started monitor appears, and so running
  // monitors' status/latency stay current — without this the list only updated
  // on mount, manual Refresh, or stop (#986).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    onHttpMonitorCheck(() => {
      void refreshMonitors();
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => frontendLog("network_sidebar", `Failed to subscribe to checks: ${err}`));

    return () => {
      disposed = true;
      unlisten?.();
    };
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
      <div className="network-sidebar__section" data-testid="network-monitors-section">
        <div className="network-sidebar__section-title">
          Monitors
          <Tooltip content="Refresh monitors" side="bottom">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Refresh monitors"
              icon={<RefreshCw size={11} />}
              onClick={refreshMonitors}
            />
          </Tooltip>
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
        <Button
          variant="ghost"
          size="sm"
          fullWidth
          className="network-sidebar__list-btn"
          icon={<Plus size={12} />}
          onClick={() => openNetworkDiagnosticTab("http-monitor")}
          data-testid="network-new-monitor"
        >
          New Monitor
        </Button>
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
