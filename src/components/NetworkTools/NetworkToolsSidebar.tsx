import { useCallback, useEffect, useState } from "react";
import "./NetworkTools.css";
import {
  Play,
  Pause,
  RefreshCw,
  Plus,
  Circle,
  StopCircle,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import {
  networkHttpMonitorList,
  networkHttpMonitorStop,
  networkHttpMonitorRemove,
  networkHttpMonitorPause,
  networkHttpMonitorResume,
  onHttpMonitorCheck,
} from "@/services/networkApi";
import type { NetworkTool } from "@/types/terminal";
import type { HttpMonitorState } from "@/types/network";
import { frontendLog } from "@/utils/frontendLog";
import { Button, Tooltip, toast } from "@/components/ui";
import { isMonitorStale, formatCheckedAgo } from "./monitorStaleness";

/**
 * How often the sidebar re-evaluates monitor ages/staleness. The backend poller
 * only emits on each check, so without this tick a long-interval monitor's
 * "checked N ago" label would freeze and it would never flip to overdue between
 * polls (audit gap #11).
 */
const STALENESS_TICK_MS = 5_000;

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
      className="network-sidebar__list-action"
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
  now: number;
  onStop: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRemove: (id: string) => void;
  onOpen: (id: string) => void;
}

function MonitorRow({
  monitor,
  now,
  onStop,
  onPause,
  onResume,
  onRemove,
  onOpen,
}: MonitorRowProps) {
  const { config, running, paused, lastResult } = monitor;
  const shortUrl = config.url.replace(/^https?:\/\//, "").slice(0, 24);
  const stale = isMonitorStale(lastResult?.timestampMs, config.intervalMs, now);

  return (
    <div className="network-sidebar__monitor" data-testid={`monitor-row-${config.id}`}>
      <div className="network-sidebar__monitor-info" onClick={() => onOpen(config.id)}>
        <Circle
          size={8}
          fill={
            running
              ? stale
                ? "var(--color-warning)"
                : lastResult?.ok
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
        {!lastResult && running && !paused && (
          <span className="network-sidebar__monitor-status">checking…</span>
        )}
        {running && paused && <span className="network-sidebar__monitor-status">paused</span>}
        {!running && <span className="network-sidebar__monitor-status">stopped</span>}
        {lastResult && (
          <span
            className={`network-sidebar__monitor-age${
              stale ? " network-sidebar__monitor-age--stale" : ""
            }`}
          >
            {stale && (
              <Tooltip
                content={`Overdue: last check was more than 2× the ${Math.round(
                  config.intervalMs / 1000
                )}s interval ago; this reading may be out of date`}
                side="left"
              >
                <span
                  className="network-sidebar__monitor-stale"
                  data-testid={`monitor-stale-${config.id}`}
                >
                  <AlertTriangle size={10} aria-hidden="true" />
                  overdue
                </span>
              </Tooltip>
            )}
            {formatCheckedAgo(lastResult.timestampMs, now)}
          </span>
        )}
      </div>
      {running && !paused && (
        <Tooltip content="Pause monitor" side="left">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Pause monitor"
            icon={<Pause size={12} />}
            onClick={() => onPause(config.id)}
          />
        </Tooltip>
      )}
      {(paused || !running) && (
        <Tooltip content="Resume monitor" side="left">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Resume monitor"
            icon={<Play size={12} />}
            onClick={() => onResume(config.id)}
          />
        </Tooltip>
      )}
      {running && (
        <Tooltip content="Stop monitor" side="left">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Stop monitor"
            icon={<StopCircle size={12} />}
            onClick={() => onStop(config.id)}
          />
        </Tooltip>
      )}
      <Tooltip content="Remove monitor" side="left">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Remove monitor"
          icon={<Trash2 size={12} />}
          onClick={() => onRemove(config.id)}
        />
      </Tooltip>
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

  // A ticking "now" so relative ages and the overdue flag refresh on their own
  // between check events — otherwise a long-interval monitor's dot would stay a
  // stale "up" until the next poll (audit gap #11).
  const [now, setNow] = useState(() => Date.now());

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

  // Advance "now" on a fixed cadence so ages age and overdue monitors surface
  // without needing a check event to arrive.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), STALENESS_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const handleStopMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorStop(id);
        await refreshMonitors();
        toast.success("Monitor stopped");
      } catch (err) {
        frontendLog("network_sidebar", `Failed to stop monitor: ${err}`);
        toast.error(`Failed to stop monitor: ${err}`);
      }
    },
    [refreshMonitors]
  );

  const handlePauseMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorPause(id);
        await refreshMonitors();
        toast.success("Monitor paused");
      } catch (err) {
        frontendLog("network_sidebar", `Failed to pause monitor: ${err}`);
        toast.error(`Failed to pause monitor: ${err}`);
      }
    },
    [refreshMonitors]
  );

  const handleResumeMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorResume(id);
        await refreshMonitors();
        toast.success("Monitor resumed");
      } catch (err) {
        frontendLog("network_sidebar", `Failed to resume monitor: ${err}`);
        toast.error(`Failed to resume monitor: ${err}`);
      }
    },
    [refreshMonitors]
  );

  const handleRemoveMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorRemove(id);
        await refreshMonitors();
        toast.success("Monitor removed");
      } catch (err) {
        frontendLog("network_sidebar", `Failed to remove monitor: ${err}`);
        toast.error(`Failed to remove monitor: ${err}`);
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
        <QuickAction label="Ping Sweep…" tool="ping-sweep" />
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
              iconOnly
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
            now={now}
            onStop={handleStopMonitor}
            onPause={handlePauseMonitor}
            onResume={handleResumeMonitor}
            onRemove={handleRemoveMonitor}
            onOpen={handleOpenMonitor}
          />
        ))}
        <Button
          variant="ghost"
          size="sm"
          fullWidth
          className="network-sidebar__list-action"
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
