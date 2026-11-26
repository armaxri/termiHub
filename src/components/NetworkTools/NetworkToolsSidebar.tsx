import { useCallback, useEffect, useId, useState, type MouseEvent } from "react";
import { monitorServiceState, serviceStateDot } from "@/utils/serviceState";
import { t, tf } from "@/i18n/catalog";
import { hostChoice, type HostChoice } from "@/utils/hostChoice";
import { useConnectAgent } from "@/hooks/useConnectAgent";
import "@/components/ServiceListItem/ServiceListItem.css";
import { useProjectedAgents } from "@/store/useProjectedAgents";
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
  HardDrive,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import {
  networkHttpMonitorList,
  networkHttpMonitorStop,
  networkHttpMonitorRemove,
  networkHttpMonitorPause,
  networkHttpMonitorResume,
  onHttpMonitorChanged,
  onHttpMonitorCheck,
} from "@/services/networkApi";
import type { NetworkTool } from "@/types/terminal";
import type { HttpMonitorState } from "@/types/network";
import { frontendLog } from "@/utils/frontendLog";
import { Button, Tooltip, EmptyState, StatusDot, toast } from "@/components/ui";
import type { StatusTone } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import { isMonitorStale } from "./monitorStaleness";
import {
  monitorNextSteps,
  monitorRowMarker,
  monitorRowName,
  monitorRowTooltip,
  monitorRunActions,
  type MonitorNextStep,
} from "./monitorRow";
import { errorMessage } from "@/utils/errorMessage";

/**
 * How often the sidebar re-evaluates monitor ages/staleness. The backend poller
 * only emits on each check, so without this tick a long-interval monitor's
 * "checked N ago" tooltip line would freeze and it would never flip to overdue between
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
  /** The machine it checks from, by name; none for this computer (#6039). */
  runsOn?: string;
  /** Where it runs, as stored (F-009). */
  host: HostChoice;
  /** Whether the agent it runs on is connected. */
  agentConnected: boolean;
  onNextStep: (step: MonitorNextStep["id"], id: string) => void;
}

/** Tone and accessible name of a monitor's status dot. */
function monitorStatus(
  monitor: HttpMonitorState,
  stale: boolean
): { tone: StatusTone; label: string; pulse?: boolean; hollow?: boolean } {
  const { running, paused, lastResult } = monitor;
  // On an agent, the states of a service (#6052).
  const state = monitorServiceState(monitor);
  // Its agent is gone: nothing is known, grey, unlike Stopping (F-009 round 2).
  if (state === "notReachable") {
    return { tone: "neutral", label: t("monitor.state.agentOffline"), hollow: true };
  }
  if (state === "error") return { tone: "error", label: t("monitor.state.notStarted") };
  if (state !== "running" && state !== "stopped") {
    const dot = serviceStateDot(state);
    return { tone: dot.tone, label: dot.label, pulse: dot.pulse };
  }
  if (!running) return { tone: "neutral", label: "Stopped" };
  if (paused) return { tone: "neutral", label: "Paused" };
  if (!lastResult) return { tone: "neutral", label: "Checking", pulse: true };
  if (stale) return { tone: "warning", label: "Overdue" };
  return lastResult.ok ? { tone: "success", label: "Up" } : { tone: "error", label: "Down" };
}

/**
 * One HTTP monitor in the sidebar, built on the shared {@link SidebarListItem}
 * like the tunnel and service rows (#5193). Per the list-row rule (#5789,
 * docs/copy-style.md -> "List rows"): the status dot, the monitor's name (its
 * URL when it has none) and its description; a marker only when the state
 * needs attention (stopped, paused, overdue, down). The URL, method, interval
 * and the latest reading are in the row's tooltip.
 */
function MonitorRow({
  monitor,
  now,
  onStop,
  onPause,
  onResume,
  onRemove,
  onOpen,
  runsOn,
  host,
  agentConnected,
  onNextStep,
}: MonitorRowProps) {
  const { config, lastResult } = monitor;
  // Only what can be done now, and what helps with why it does not check (F-009).
  const runs = monitorRunActions(monitor, host);
  const nextSteps = monitorNextSteps(monitor, host, agentConnected);
  const state = monitorServiceState(monitor);
  const where =
    runsOn ?? t(host.kind === "thisComputer" ? "monitor.where.here" : "monitor.where.unknown");
  const stale = isMonitorStale(lastResult?.timestampMs, config.intervalMs, now);
  const status = monitorStatus(monitor, stale);
  const marker = monitorRowMarker(monitor, now);
  const label = config.name?.trim() || config.url;
  // The marker reads as the Open button's description, its name being the
  // monitor's name or full URL (#4349).
  const idBase = useId();
  const markerId = `${idBase}-marker`;

  /** Run a row action without the click also opening the monitor. */
  const act = (fn: (id: string) => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn(config.id);
  };

  const markerEl =
    marker.kind === "overdue" ? (
      <Tooltip
        content={`Overdue: last check was more than 2× the ${Math.round(
          config.intervalMs / 1000
        )}s interval ago; this reading may be out of date`}
        side="left"
      >
        <span
          id={markerId}
          className="network-sidebar__monitor-stale"
          data-testid={`monitor-stale-${config.id}`}
        >
          <AlertTriangle size={10} aria-hidden="true" />
          {marker.label}
        </span>
      </Tooltip>
    ) : (
      <span
        id={markerId}
        className={marker.kind === "down" ? "network-sidebar__monitor-down" : undefined}
        data-testid={`monitor-marker-${config.id}`}
      >
        {marker.label}
      </span>
    );

  return (
    <SidebarListItem
      testId={`monitor-row-${config.id}`}
      nameTestId={`monitor-url-${config.id}`}
      name={monitorRowName(monitor)}
      nameTooltip={label}
      description={config.description}
      descriptionTestId={`monitor-description-${config.id}`}
      tooltip={monitorRowTooltip(monitor, now, runsOn)}
      tooltipTestId={`monitor-tooltip-${config.id}`}
      onClick={() => onOpen(config.id)}
      status={
        <StatusDot
          tone={status.tone}
          label={status.label}
          pulse={status.pulse}
          hollow={status.hollow}
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
              aria-label={`Open monitor ${label}`}
              aria-describedby={marker ? markerId : undefined}
              data-testid={`monitor-open-${config.id}`}
              icon={<Activity size={12} />}
              onClick={act(onOpen)}
            />
          </Tooltip>
          {runs.pause && (
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
          {runs.resume && (
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
          {runs.stop && (
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
          <Tooltip content="Delete monitor" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Delete monitor"
              icon={<Trash2 size={12} />}
              onClick={act(onRemove)}
            />
          </Tooltip>
        </>
      }
      details={
        <>
          {/* Where it runs, always; a long name is cut at its end (F-009 round 2). */}
          <Tooltip content={tf("monitor.tooltip.runsOn", { machine: where })} side="right">
            <span className="service-row__machine" data-testid={`monitor-machine-${config.id}`}>
              <HardDrive size={11} className="service-row__machine-icon" aria-hidden="true" />
              <span className="network-sidebar__monitor-where">{where}</span>
            </span>
          </Tooltip>
          <span className="network-sidebar__monitor-meta" data-testid={`monitor-meta-${config.id}`}>
            {markerEl}
          </span>
          {(monitor.reason || nextSteps.length > 0) && (
            <span
              className="service-row__reason network-sidebar__monitor-reason"
              data-state={state}
              data-testid={`monitor-reason-${config.id}`}
            >
              {monitor.reason}
              {nextSteps.map((step) => (
                <span key={step.id}>
                  {" "}
                  <button
                    type="button"
                    className="service-row__next"
                    data-testid={`monitor-step-${step.id}-${config.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onNextStep(step.id, config.id);
                    }}
                  >
                    {step.label}
                  </button>
                </span>
              ))}
            </span>
          )}
        </>
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
  const { remoteAgents } = useProjectedAgents();
  const connectAgent = useConnectAgent();
  /** The machine a monitor checks from, by name; none for this computer (#6039). */
  const runsOnOf = (monitor: HttpMonitorState): string | undefined => {
    const host = hostChoice(monitor.config.host);
    if (host.kind !== "agent") return undefined;
    return remoteAgents.find((a) => a.id === host.agentId)?.name ?? host.agentId;
  };

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
    let unlistenChanged: (() => void) | null = null;
    const keep = (fn: () => void, into: (fn: () => void) => void) => (disposed ? fn() : into(fn));
    const failed = (err: unknown) =>
      frontendLog("network_sidebar", `Failed to subscribe to checks: ${errorMessage(err)}`);
    onHttpMonitorCheck(() => {
      void refreshMonitors();
    })
      .then((fn) => keep(fn, (f) => (unlisten = f)))
      .catch(failed);
    // Its agent went or came back (#6052): the row says so without a check.
    onHttpMonitorChanged(() => {
      void refreshMonitors();
    })
      .then((fn) => keep(fn, (f) => (unlistenChanged = f)))
      .catch(failed);

    return () => {
      disposed = true;
      unlisten?.();
      unlistenChanged?.();
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
      } catch (err) {
        frontendLog("network_sidebar", `Failed to remove monitor: ${errorMessage(err)}`);
        toast.error(`Failed to remove monitor: ${errorMessage(err)}`);
      }
    },
    [refreshMonitors]
  );

  /** Whether the agent `monitor` runs on is connected. */
  const agentConnected = (monitor: HttpMonitorState): boolean => {
    const host = hostChoice(monitor.config.host);
    return (
      host.kind === "agent" &&
      remoteAgents.find((a) => a.id === host.agentId)?.connectionState === "connected"
    );
  };

  /** A reason's next step (F-009): connect its agent, or open it to set it up again. */
  const handleNextStep = (step: MonitorNextStep["id"], id: string) => {
    const monitor = httpMonitors.find((m) => m.config.id === id);
    const host = monitor ? hostChoice(monitor.config.host) : undefined;
    if (step === "connectAgent" && host?.kind === "agent") {
      void connectAgent(host.agentId);
      return;
    }
    openNetworkDiagnosticTab("http-monitor");
  };

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
        <div className="network-sidebar__section-title">Quick actions</div>
        <QuickAction label="Ping host…" tool="ping" />
        <QuickAction label="Ping sweep…" tool="ping-sweep" />
        <QuickAction label="Scan ports…" tool="port-scanner" />
        <QuickAction label="DNS lookup…" tool="dns-lookup" />
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
            host={hostChoice(m.config.host)}
            agentConnected={agentConnected(m)}
            onNextStep={handleNextStep}
            now={now}
            onStop={handleStopMonitor}
            onPause={handlePauseMonitor}
            onResume={handleResumeMonitor}
            onRemove={handleRemoveMonitor}
            onOpen={handleOpenMonitor}
            runsOn={runsOnOf(m)}
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
          New monitor
        </Button>
      </div>

      {/* Local Utilities */}
      <div className="network-sidebar__section">
        <div className="network-sidebar__section-title">Local</div>
        <QuickAction label="View open ports" tool="open-ports" />
        <QuickAction label="Traceroute…" tool="traceroute" />
      </div>
    </div>
  );
}
