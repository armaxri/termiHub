import { useCallback, useEffect, useId, useState, type MouseEvent, type ReactNode } from "react";
import "./NetworkTools.css";
import {
  Activity,
  Play,
  Pause,
  RefreshCw,
  Plus,
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
import { Button, Tooltip, EmptyState, StatusDot, toast } from "@/components/ui";
import type { StatusTone } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import { isMonitorStale, formatCheckedAgo } from "./monitorStaleness";
import { errorMessage } from "@/utils/errorMessage";

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

/** Tone and accessible name of a monitor's status dot. */
function monitorStatus(
  monitor: HttpMonitorState,
  stale: boolean
): { tone: StatusTone; label: string; pulse?: boolean } {
  const { running, paused, lastResult } = monitor;
  if (!running) return { tone: "neutral", label: "Stopped" };
  if (paused) return { tone: "neutral", label: "Paused" };
  if (!lastResult) return { tone: "neutral", label: "Checking", pulse: true };
  if (stale) return { tone: "warning", label: "Overdue" };
  return lastResult.ok ? { tone: "success", label: "Up" } : { tone: "error", label: "Down" };
}

/**
 * One HTTP monitor in the sidebar, built on the shared {@link SidebarListItem}
 * like the tunnel and service rows (#5193): status dot, URL and hover/focus
 * actions on the first line, the latest reading and its age on the second.
 */
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
  // CSS cuts the URL to the row; the tooltip then shows it in full (#4954).
  const shortUrl = config.url.replace(/^https?:\/\//, "");
  const stale = isMonitorStale(lastResult?.timestampMs, config.intervalMs, now);
  const status = monitorStatus(monitor, stale);
  // The status and age read as the Open button's description, its name being
  // the full URL (the visible one is truncated) (#4349).
  const idBase = useId();
  const resultId = `${idBase}-result`;
  const stateId = `${idBase}-state`;
  const ageId = `${idBase}-age`;
  const checking = !lastResult && running && !paused;
  const stateText = checking
    ? "checking…"
    : running && paused
      ? "paused"
      : !running
        ? "stopped"
        : null;
  const describedBy = [
    lastResult ? resultId : null,
    stateText ? stateId : null,
    lastResult ? ageId : null,
  ]
    .filter(Boolean)
    .join(" ");

  /** Run a row action without the click also opening the monitor. */
  const act = (fn: (id: string) => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn(config.id);
  };

  const parts: ReactNode[] = [];
  if (lastResult) {
    parts.push(
      <span
        key="result"
        id={resultId}
        className={lastResult.ok ? undefined : "network-sidebar__monitor-down"}
      >
        {lastResult.ok ? `${lastResult.statusCode} · ${lastResult.latencyMs}ms` : "✗ down"}
      </span>
    );
  }
  if (stateText) {
    parts.push(
      <span key="state" id={stateId}>
        {stateText}
      </span>
    );
  }
  if (lastResult) {
    parts.push(
      <span
        key="age"
        id={ageId}
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
    );
  }

  return (
    <SidebarListItem
      testId={`monitor-row-${config.id}`}
      nameTestId={`monitor-url-${config.id}`}
      name={shortUrl}
      nameTooltip={config.url}
      onClick={() => onOpen(config.id)}
      status={
        <StatusDot
          tone={status.tone}
          label={status.label}
          pulse={status.pulse}
          testId={`monitor-status-${config.id}`}
        />
      }
      actions={
        <>
          <Tooltip content="Open monitor" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Open monitor ${config.url}`}
              aria-describedby={describedBy || undefined}
              data-testid={`monitor-open-${config.id}`}
              icon={<Activity size={12} />}
              onClick={act(onOpen)}
            />
          </Tooltip>
          {running && !paused && (
            <Tooltip content="Pause monitor" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Pause monitor"
                icon={<Pause size={12} />}
                onClick={act(onPause)}
              />
            </Tooltip>
          )}
          {(paused || !running) && (
            <Tooltip content="Resume monitor" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Resume monitor"
                icon={<Play size={12} />}
                onClick={act(onResume)}
              />
            </Tooltip>
          )}
          {running && (
            <Tooltip content="Stop monitor" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Stop monitor"
                icon={<StopCircle size={12} />}
                onClick={act(onStop)}
              />
            </Tooltip>
          )}
          <Tooltip content="Remove monitor" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Remove monitor"
              icon={<Trash2 size={12} />}
              onClick={act(onRemove)}
            />
          </Tooltip>
        </>
      }
      details={
        <span className="network-sidebar__monitor-meta" data-testid={`monitor-meta-${config.id}`}>
          {parts.flatMap((part, i) =>
            i === 0
              ? [part]
              : [
                  <span key={`sep-${i}`} aria-hidden="true">
                    ·
                  </span>,
                  part,
                ]
          )}
        </span>
      }
    />
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
      frontendLog("network_sidebar", `Failed to load monitors: ${errorMessage(err)}`);
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
      .catch((err) =>
        frontendLog("network_sidebar", `Failed to subscribe to checks: ${errorMessage(err)}`)
      );

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
        frontendLog("network_sidebar", `Failed to stop monitor: ${errorMessage(err)}`);
        toast.error(`Failed to stop monitor: ${errorMessage(err)}`);
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
        frontendLog("network_sidebar", `Failed to pause monitor: ${errorMessage(err)}`);
        toast.error(`Failed to pause monitor: ${errorMessage(err)}`);
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
        frontendLog("network_sidebar", `Failed to resume monitor: ${errorMessage(err)}`);
        toast.error(`Failed to resume monitor: ${errorMessage(err)}`);
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
        frontendLog("network_sidebar", `Failed to remove monitor: ${errorMessage(err)}`);
        toast.error(`Failed to remove monitor: ${errorMessage(err)}`);
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
        {httpMonitors.length === 0 && <EmptyState title="No monitors running" />}
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
