import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Terminal,
  Server,
  ArrowLeftRight,
  FolderOpen,
  Activity,
  MonitorStop,
  MonitorCog,
  Globe,
  Loader2,
  ArrowDownUp,
  Download,
  Upload,
  Ban,
  Pause,
  Play,
  RotateCw,
  Timer,
  Check,
  Unplug,
  Power,
  Package,
  AppWindow,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Modal, Button, Tooltip, Progress, ConfirmDialog, toast } from "@/components/ui";
import { formatBytes } from "@/utils/formatters";
import type { TransferState } from "@/types/connection";
import type { MonitoringEntry } from "@/types/monitoring";
import { MONITORING_INTERVAL_OPTIONS, DEFAULT_MONITORING_INTERVAL_MS } from "@/types/monitoring";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import {
  listLocalSessions,
  listAgentSessions,
  closeTerminal,
  closeAgentSession,
  cancelConnecting,
  cancelConnectAgent,
  pruneDeadAgents,
  xServerStatus,
  xServerStop,
  listSessionOwners,
  focusWindow,
  LocalSessionInfo,
  AgentSessionInfo,
} from "@/services/api";
import {
  networkHttpMonitorStop,
  networkHttpMonitorStopAll,
  networkHttpMonitorList,
} from "@/services/networkApi";
import { frontendLog } from "@/utils/frontendLog";
import { XServerStatusReport } from "@/types/xserver";
import { resolveAgentUpdateState } from "@/utils/agentVersion";
import { useDesktopVersion } from "@/hooks/useDesktopVersion";
import { useWindowInfo } from "@/hooks/useWindowInfo";
import { windowDisplayName } from "@/utils/windowPicker";
import { AgentVersionBadge } from "@/components/AgentVersionBadge/AgentVersionBadge";
import { XServerSetupDialog } from "./XServerSetupDialog";
import "./OpenConnectionsModal.css";

interface OpenConnectionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AgentSessionsState {
  [agentId: string]: AgentSessionInfo[];
}

interface ProxySessionsState {
  [agentId: string]: LocalSessionInfo[];
}

/**
 * Modal that lists every open connection across all subsystems and lets the
 * user kill individual connections or entire sections at once.
 */
export function OpenConnectionsModal({ open, onOpenChange }: OpenConnectionsModalProps) {
  const remoteAgents = useAppStore((s) => s.remoteAgents);
  const desktopVersion = useDesktopVersion();
  // How many native windows are open. The owning-window badge/focus affordance
  // (#1926) is shown only with >1 window, so single-window users see no change —
  // mirroring the StatusBar window affordance (#1902).
  const { count: windowCount } = useWindowInfo();
  const multiWindow = windowCount > 1;
  const disconnectRemoteAgent = useAppStore((s) => s.disconnectRemoteAgent);
  const shutdownRemoteAgent = useAppStore((s) => s.shutdownRemoteAgent);
  const stopTunnel = useAppStore((s) => s.stopTunnel);
  const tunnels = useAppStore((s) => s.tunnels);
  // Live single source of truth for tunnel status (kept in sync by tunnel
  // events); the panel reads it directly so it never drifts from the sidebar.
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const sftpSessions = useAppStore((s) => s.sftpSessions);
  const closeSftpSession = useAppStore((s) => s.closeSftpSession);
  const transfers = useAppStore((s) => s.transfers);
  const cancelTransfer = useAppStore((s) => s.cancelTransfer);
  const tabGroups = useAppStore((s) => s.tabGroups);
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId);
  // Every monitored host with a live backend subscription (#1231, audit gap G6);
  // each renders its own killable row. Derived from the keyed `monitors` map.
  const monitors = useAppStore((s) => s.monitors);
  const openMonitors = useMemo(
    () => Object.values(monitors).filter((m) => m.monitorSessionId !== null),
    [monitors]
  );
  const disconnectMonitoring = useAppStore((s) => s.disconnectMonitoring);
  const setMonitoringPaused = useAppStore((s) => s.setMonitoringPaused);
  const setMonitoringInterval = useAppStore((s) => s.setMonitoringInterval);
  const connectMonitoring = useAppStore((s) => s.connectMonitoring);
  // Live source of truth for HTTP monitors (kept current by the Network Tools
  // sidebar / check events); the panel reads it directly so it stays in sync
  // and this "kill everything" surface can see and stop the poll loops (#1147).
  const httpMonitors = useAppStore((s) => s.httpMonitors);
  const setHttpMonitors = useAppStore((s) => s.setHttpMonitors);
  const rootPanel = useAppStore((s) => s.rootPanel);
  const terminalConnecting = useAppStore((s) => s.terminalConnecting);
  const closeTab = useAppStore((s) => s.closeTab);
  const markSessionKilled = useAppStore((s) => s.markSessionKilled);

  // Sessions still establishing their connection (visible as connecting tabs).
  // Cancelling aborts the in-flight handshake instead of waiting it out (#952).
  const connectingTabs = getAllLeaves(rootPanel)
    .flatMap((leaf) => leaf.tabs)
    .filter((tab) => terminalConnecting[tab.id]);

  // Every tab across all tab groups (the active group is the live rootPanel, the
  // others their stored trees), walked once and reused below.
  const allTabs = tabGroups.flatMap((g) =>
    getAllLeaves(g.id === activeTabGroupId ? rootPanel : g.rootPanel).flatMap((leaf) => leaf.tabs)
  );

  // Every live tab id — used to flag orphaned SFTP sessions whose owning tab no
  // longer exists (#1241, orphan safety net).
  const liveTabIds = new Set(allTabs.map((t) => t.id));

  // Session ids of spawned containers whose tab is still live (#1446): tabs
  // opened from an external `termiHub spawn` with no saved connection id. This
  // is now a FALLBACK for sessions predating the backend marker (#1466) — the
  // authoritative source is `LocalSessionInfo.spawned`, recorded on the session
  // itself so grouping survives the tab close that strips this flag.
  const spawnedTabSessionIds = new Set(
    allTabs.filter((t) => t.spawned && t.sessionId).map((t) => t.sessionId as string)
  );

  // One entry per live backend SFTP session, keyed by its UUID. Orphaned
  // sessions (owning tab gone) still surface here so they stay killable.
  const sftpSessionEntries = Object.entries(sftpSessions).map(([id, entry]) => ({
    id,
    hostLabel: entry.hostLabel,
    orphaned: !liveTabIds.has(entry.owningTabId),
  }));

  // Live in-flight SFTP transfers (#1247). The store keeps only `transferring`
  // rows; terminal-phase transfers are auto-removed, so every value here is live.
  const transferList = Object.values(transfers);

  const [localSessions, setLocalSessions] = useState<LocalSessionInfo[]>([]);
  const [proxySessions, setProxySessions] = useState<ProxySessionsState>({});
  const [agentSessions, setAgentSessions] = useState<AgentSessionsState>({});
  const [xServer, setXServer] = useState<XServerStatusReport | null>(null);
  const [xServerSetupOpen, setXServerSetupOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // Snapshot of the backend `session_id → owning_window` map (#1900), read when
  // the panel opens. Sparse — only claimed sessions (e.g. moved between windows)
  // appear — so a session with no entry renders no window badge.
  const [sessionOwners, setSessionOwners] = useState<Record<string, string>>({});

  // Split backend-local sessions: spawned containers get their own section, the
  // rest stay under "Local Sessions" (#1446). A session is spawned when the
  // backend marker says so (`s.spawned`, #1466 — authoritative, survives a tab
  // close so orphans stay visible + killable here) OR, as a fallback for
  // sessions predating the marker, when a live spawned tab still owns it. Keeps
  // spawned containers tracked separately from configured connections and avoids
  // double-listing.
  const isSpawned = (s: LocalSessionInfo) => s.spawned === true || spawnedTabSessionIds.has(s.id);
  const spawnedSessions = localSessions.filter(isSpawned);
  const plainLocalSessions = localSessions.filter((s) => !isSpawned(s));

  const connectedAgents = remoteAgents.filter((a) => a.connectionState === "connected");

  // Agents still establishing (connecting) or recovering (reconnecting) their
  // transport. Previously hidden — the panel only listed "connected" agents — so
  // a stuck connect or a failing reconnect had no visible, killable surface (G2,
  // #1235). Connecting → cancel the in-flight handshake; reconnecting → kill the
  // backoff loop by disconnecting.
  const establishingAgents = remoteAgents.filter(
    (a) => a.connectionState === "connecting" || a.connectionState === "reconnecting"
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [locals, xServerReport, owners, ...agentSessionArrays] = await Promise.all([
        listLocalSessions(),
        xServerStatus().catch(() => null),
        listSessionOwners().catch(() => ({}) as Record<string, string>),
        ...connectedAgents.map((a) => listAgentSessions(a.id).catch(() => [])),
      ]);

      setLocalSessions(locals.filter((s) => !s.agentId));
      setXServer(xServerReport as XServerStatusReport | null);
      setSessionOwners(owners as Record<string, string>);

      const byProxy: ProxySessionsState = {};
      for (const s of locals) {
        if (s.agentId) {
          (byProxy[s.agentId] ??= []).push(s);
        }
      }
      setProxySessions(byProxy);

      const byAgent: AgentSessionsState = {};
      connectedAgents.forEach((a, i) => {
        byAgent[a.id] = agentSessionArrays[i] as AgentSessionInfo[];
      });
      setAgentSessions(byAgent);
    } finally {
      setLoading(false);
    }
  }, [connectedAgents.map((a) => a.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) {
      void loadData();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Include errored / reconnecting tunnels, not just connected/connecting: an
  // errored tunnel still holds a leaked `active_tunnels` entry + pool guards, so
  // it must be force-Stoppable from the canonical kill panel (#1240). stop_tunnel
  // releases the leak and clears the persisted error (#1238).
  const activeTunnels = tunnels.filter((t) => {
    const state = tunnelStates[t.id];
    return (
      state &&
      (state.status === "connected" ||
        state.status === "connecting" ||
        state.status === "reconnecting" ||
        state.status === "error")
    );
  });

  // Only surface a live X server: a managed one that is running, or an adopted
  // external one. Absent/failed servers have nothing to list or stop.
  const showXServer =
    xServer !== null && (xServer.state === "running" || xServer.state === "adopted");
  const xServerManaged = xServer?.state === "running" && xServer.managed === true;

  // "display :N" plus, when any sessions depend on the server, "· N sessions"
  // (singular for one). Omitted entirely when there is no display to show.
  const xServerDetail = (() => {
    if (!xServer || xServer.displayNumber === undefined) return undefined;
    const base = `display :${xServer.displayNumber}`;
    const count = xServer.sessionCount ?? 0;
    if (count <= 0) return base;
    const noun = count === 1 ? "session" : "sessions";
    return `${base} · ${count} ${noun}`;
  })();

  // When no live server exists (absent/failed/unknown), offer a Set up affordance
  // instead. Suppressed while loading so the row doesn't flash before status
  // arrives. This affordance is not counted as an active connection.
  const showXServerSetup = !loading && !showXServer;

  const totalCount =
    connectingTabs.length +
    establishingAgents.length +
    localSessions.length +
    connectedAgents.length +
    Object.values(proxySessions).reduce((s, arr) => s + arr.length, 0) +
    Object.values(agentSessions).reduce((s, arr) => s + arr.length, 0) +
    activeTunnels.length +
    transferList.length +
    sftpSessionEntries.length +
    openMonitors.length +
    httpMonitors.length +
    (showXServer ? 1 : 0);

  const handleCancelConnecting = async (tabId: string, panelId: string) => {
    await cancelConnecting(tabId).catch(() => {});
    closeTab(tabId, panelId);
  };

  const handleCancelAllConnecting = async () => {
    await Promise.all(connectingTabs.map((t) => cancelConnecting(t.id).catch(() => {})));
    connectingTabs.forEach((t) => closeTab(t.id, t.panelId));
  };

  // Cancel/kill an establishing (connecting) or recovering (reconnecting) agent.
  // Connecting → cancel_connect_agent aborts the in-flight handshake; reconnecting
  // → disconnect ends the backoff loop (sets alive=false). The backend is the
  // single writer of connectionState, so the row clears when its event lands.
  const handleCancelEstablishingAgent = async (
    agentId: string,
    state: "connecting" | "reconnecting"
  ) => {
    try {
      if (state === "connecting") {
        await cancelConnectAgent(agentId);
        toast.success("Connect cancelled");
      } else {
        await disconnectRemoteAgent(agentId);
        toast.success("Reconnect stopped");
      }
    } catch (err) {
      frontendLog("open_connections", `Failed to cancel agent connect: ${err}`);
      toast.error(`Failed to cancel: ${err}`);
    }
  };

  const handleCancelAllEstablishingAgents = async () => {
    await Promise.all(
      establishingAgents.map((a) =>
        a.connectionState === "connecting"
          ? cancelConnectAgent(a.id).catch(() => {})
          : disconnectRemoteAgent(a.id).catch(() => {})
      )
    );
  };

  // Resolve a session's owning window into a display name (#1926). Returns null
  // when only one window is open, the session id is missing, or the session is
  // unclaimed (no ownership entry) — in all three cases the row shows no window
  // badge, so single-window users see no change.
  const resolveOwningWindow = (sessionId: string | null | undefined): OwningWindow | null => {
    if (!multiWindow || !sessionId) return null;
    const label = sessionOwners[sessionId];
    if (!label) return null;
    return { label, name: windowDisplayName(label) };
  };

  // Bring an owning window to the foreground (#1926). Focusing the current window
  // is a harmless no-op.
  const handleFocusWindow = async (label: string) => {
    try {
      await focusWindow(label);
    } catch (err) {
      frontendLog("open_connections", `Failed to focus window ${label}: ${err}`);
      toast.error(`Failed to focus window: ${err}`);
    }
  };

  const handleKillLocal = async (id: string) => {
    // Tag the kill as intentional so the terminal-exit handler suppresses the
    // "unexpected disconnect" overlay for the owning tab (#1121).
    markSessionKilled(id);
    await closeTerminal(id).catch(() => {});
    setLocalSessions((prev) => prev.filter((s) => s.id !== id));
  };

  // Kill a set of backend-local sessions at once, marking each kill intentional
  // (#1121) and dropping the killed rows from the cache. Shared by the "Local
  // Sessions" and "Spawned Containers" bulk actions (#1446).
  const killSessions = async (sessions: LocalSessionInfo[]) => {
    const ids = new Set(sessions.map((s) => s.id));
    sessions.forEach((s) => markSessionKilled(s.id));
    await Promise.all(sessions.map((s) => closeTerminal(s.id).catch(() => {})));
    setLocalSessions((prev) => prev.filter((s) => !ids.has(s.id)));
  };

  const handleKillAllLocal = () => killSessions(plainLocalSessions);

  // Kill every spawned container at once (#1446).
  const handleKillAllSpawned = () => killSessions(spawnedSessions);

  // Clear the cached native-session rows for an agent once its transport is gone
  // (both teardown intents drop the transport, so the "Sessions on <agent>"
  // section must disappear together with the agent row).
  const clearAgentSessionCache = (agentId: string) => {
    setAgentSessions((prev) => {
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  };

  // Disconnect (detach) — drop the transport but leave persistent daemon-backed
  // remote sessions running so they re-list on the next connect (G9, #1237).
  // Mirrors the agent header's Disconnect intent.
  const handleKillAgent = async (agentId: string) => {
    await disconnectRemoteAgent(agentId);
    clearAgentSessionCache(agentId);
  };

  // Shutdown (stop remote) — stop the remote sessions and disconnect, reporting
  // how many sessions the agent detached/killed as a success toast (G9, #1237).
  // Mirrors the agent header's Shutdown intent.
  const handleShutdownAgent = async (agentId: string) => {
    const detached = await shutdownRemoteAgent(agentId);
    clearAgentSessionCache(agentId);
    toast.success(
      detached > 0
        ? `Agent shut down — ${detached} session${detached === 1 ? "" : "s"} stopped`
        : "Agent shut down"
    );
  };

  const handleKillAllAgents = async () => {
    await Promise.all(connectedAgents.map((a) => disconnectRemoteAgent(a.id)));
  };

  /**
   * Sweep any backend agent whose I/O task has already died (`alive=false`) but
   * whose entry lingered in the manager map. Pure resource hygiene — routing is
   * already safe (G6, #1239).
   */
  const handlePruneDeadAgents = async () => {
    try {
      const pruned = await pruneDeadAgents();
      await loadData();
      if (pruned.length === 0) {
        toast.success("No dead agents to prune");
      } else {
        toast.success(`Pruned ${pruned.length} dead agent${pruned.length === 1 ? "" : "s"}`);
      }
    } catch (err) {
      frontendLog("open_connections", `Failed to prune dead agents: ${err}`);
      toast.error(`Failed to prune dead agents: ${err}`);
    }
  };

  const handleKillProxy = async (agentId: string, id: string) => {
    markSessionKilled(id);
    await closeTerminal(id).catch(() => {});
    setProxySessions((prev) => ({
      ...prev,
      [agentId]: (prev[agentId] ?? []).filter((s) => s.id !== id),
    }));
  };

  const handleKillAllProxy = async (agentId: string) => {
    const sessions = proxySessions[agentId] ?? [];
    sessions.forEach((s) => markSessionKilled(s.id));
    await Promise.all(sessions.map((s) => closeTerminal(s.id).catch(() => {})));
    setProxySessions((prev) => ({ ...prev, [agentId]: [] }));
  };

  const handleKillAgentSession = async (agentId: string, sessionId: string) => {
    await closeAgentSession(agentId, sessionId).catch(() => {});
    setAgentSessions((prev) => ({
      ...prev,
      [agentId]: (prev[agentId] ?? []).filter((s) => s.sessionId !== sessionId),
    }));
  };

  const handleKillAllAgentSessions = async (agentId: string) => {
    const sessions = agentSessions[agentId] ?? [];
    await Promise.all(sessions.map((s) => closeAgentSession(agentId, s.sessionId).catch(() => {})));
    setAgentSessions((prev) => ({ ...prev, [agentId]: [] }));
  };

  // stopTunnel updates the store's live tunnelStates (via tunnel events), which
  // this panel now reads directly — no separate local copy to prune.
  const handleKillTunnel = async (tunnelId: string) => {
    await stopTunnel(tunnelId);
  };

  const handleKillAllTunnels = async () => {
    await Promise.all(activeTunnels.map((t) => stopTunnel(t.id)));
  };

  const handleKillSftp = async (sessionId: string) => {
    try {
      await closeSftpSession(sessionId);
      toast.success("SFTP session closed");
    } catch (err) {
      frontendLog("open_connections", `Failed to close SFTP session: ${err}`);
      toast.error(`Failed to close SFTP session: ${err}`);
    }
  };

  const handleKillAllSftp = async () => {
    try {
      await Promise.all(sftpSessionEntries.map((s) => closeSftpSession(s.id)));
      toast.success("All SFTP sessions closed");
    } catch (err) {
      frontendLog("open_connections", `Failed to close SFTP sessions: ${err}`);
      toast.error(`Failed to close SFTP sessions: ${err}`);
    }
  };

  const handleCancelTransfer = async (transferId: string) => {
    try {
      await cancelTransfer(transferId);
      toast.success("Transfer cancelled");
    } catch (err) {
      frontendLog("open_connections", `Failed to cancel transfer: ${err}`);
      toast.error(`Failed to cancel transfer: ${err}`);
    }
  };

  const handleCancelAllTransfers = async () => {
    try {
      await Promise.all(transferList.map((t) => cancelTransfer(t.transferId)));
      toast.success("All transfers cancelled");
    } catch (err) {
      frontendLog("open_connections", `Failed to cancel transfers: ${err}`);
      toast.error(`Failed to cancel transfers: ${err}`);
    }
  };

  const handleStopXServer = async () => {
    await xServerStop().catch(() => {});
    setXServer(null);
  };

  // Refresh the store's live monitor list after a stop so the section reflects
  // the change immediately (the sidebar keeps it current the rest of the time).
  const refreshHttpMonitors = async () => {
    try {
      setHttpMonitors(await networkHttpMonitorList());
    } catch (err) {
      frontendLog("open_connections", `Failed to refresh HTTP monitors: ${err}`);
    }
  };

  const handleStopHttpMonitor = async (monitorId: string) => {
    try {
      await networkHttpMonitorStop(monitorId);
      await refreshHttpMonitors();
      toast.success("Monitor stopped");
    } catch (err) {
      frontendLog("open_connections", `Failed to stop HTTP monitor: ${err}`);
      toast.error(`Failed to stop monitor: ${err}`);
    }
  };

  const handleStopAllHttpMonitors = async () => {
    try {
      await networkHttpMonitorStopAll();
      await refreshHttpMonitors();
      toast.success("All monitors stopped");
    } catch (err) {
      frontendLog("open_connections", `Failed to stop all HTTP monitors: ${err}`);
      toast.error(`Failed to stop monitors: ${err}`);
    }
  };

  // ── Per-host monitoring lifecycle (#1233) ────────────────────────────────

  const handleToggleMonitorPaused = async (key: string, paused: boolean) => {
    try {
      await setMonitoringPaused(key, paused);
      toast.success(paused ? "Monitoring paused" : "Monitoring resumed");
    } catch (err) {
      frontendLog("open_connections", `Failed to toggle monitoring pause: ${err}`);
      toast.error(`Failed to ${paused ? "pause" : "resume"} monitoring: ${err}`);
    }
  };

  const handleSetMonitorInterval = async (key: string, intervalMs: number) => {
    try {
      await setMonitoringInterval(key, intervalMs);
      toast.success(`Refresh interval set to ${formatMonitorInterval(intervalMs)}`);
    } catch (err) {
      frontendLog("open_connections", `Failed to set monitoring interval: ${err}`);
      toast.error(`Failed to set interval: ${err}`);
    }
  };

  // Retry re-establishes a monitor that dropped to stale/offline: tear down the
  // stale subscription and re-subscribe the session's MonitoringProvider push
  // stream (#1232/#1233), flipping its status back to connecting → live.
  const handleRetryMonitor = async (key: string) => {
    const host = monitors[key]?.host ?? null;
    try {
      await disconnectMonitoring(key);
      await connectMonitoring(key, host);
      toast.success("Retrying monitor");
    } catch (err) {
      frontendLog("open_connections", `Failed to retry monitoring: ${err}`);
      toast.error(`Failed to retry monitoring: ${err}`);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="open-connections__title-row">
          Open Connections
          {totalCount > 0 && <span className="oc-section__count">{totalCount}</span>}
        </span>
      }
      footer={
        <Tooltip
          content="Remove backend agent entries whose connection has already died"
          side="top"
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={handlePruneDeadAgents}
            data-testid="open-connections-prune-dead-agents"
          >
            Prune dead agents
          </Button>
        </Tooltip>
      }
    >
      <div className="open-connections__body">
        {loading && totalCount === 0 && <div className="open-connections__empty">Loading…</div>}
        {!loading && totalCount === 0 && !showXServerSetup && (
          <div className="open-connections__empty">No open connections.</div>
        )}

        {/* Connecting (in-flight handshakes) */}
        {connectingTabs.length > 0 && (
          <Section
            title="Connecting"
            icon={<Loader2 size={14} />}
            count={connectingTabs.length}
            onKillAll={handleCancelAllConnecting}
          >
            {connectingTabs.map((tab) => (
              <ConnectionRow
                key={tab.id}
                icon={<Loader2 size={14} />}
                title={tab.title}
                badge="connecting"
                onKill={() => handleCancelConnecting(tab.id, tab.panelId)}
              />
            ))}
          </Section>
        )}

        {/* Establishing / recovering agents (connecting or reconnecting) */}
        {establishingAgents.length > 0 && (
          <Section
            title="Establishing / recovering"
            icon={<Loader2 size={14} />}
            count={establishingAgents.length}
            onKillAll={handleCancelAllEstablishingAgents}
            killAllLabel="Cancel All"
            data-testid="open-connections-establishing-agents-section"
          >
            {establishingAgents.map((a) => (
              <ConnectionRow
                key={a.id}
                icon={
                  a.connectionState === "reconnecting" ? (
                    <Server size={14} />
                  ) : (
                    <Loader2 size={14} />
                  )
                }
                title={a.name}
                badge={a.connectionState === "reconnecting" ? "reconnecting" : "connecting"}
                onKill={() =>
                  handleCancelEstablishingAgent(
                    a.id,
                    a.connectionState === "reconnecting" ? "reconnecting" : "connecting"
                  )
                }
                killLabel="Cancel"
              />
            ))}
          </Section>
        )}

        {/* Local Sessions (excluding spawned containers, tracked below) */}
        {plainLocalSessions.length > 0 && (
          <Section
            title="Local Sessions"
            icon={<Terminal size={14} />}
            count={plainLocalSessions.length}
            onKillAll={handleKillAllLocal}
          >
            {plainLocalSessions.map((s) => (
              <ConnectionRow
                key={s.id}
                icon={<Terminal size={14} />}
                title={s.title}
                badge={s.alive ? "alive" : "dead"}
                owningWindow={resolveOwningWindow(s.id)}
                onFocusWindow={handleFocusWindow}
                onKill={() => handleKillLocal(s.id)}
              />
            ))}
          </Section>
        )}

        {/* Spawned Containers — opened from an external `termiHub spawn`, no
            saved connection id, so tracked separately from configured Docker
            connections (#1446). */}
        {spawnedSessions.length > 0 && (
          <Section
            title="Spawned Containers"
            icon={<Package size={14} />}
            count={spawnedSessions.length}
            onKillAll={handleKillAllSpawned}
            data-testid="open-connections-spawned-section"
          >
            {spawnedSessions.map((s) => (
              <ConnectionRow
                key={s.id}
                icon={<Package size={14} />}
                title={s.title}
                badge={s.alive ? "spawned" : "dead"}
                owningWindow={resolveOwningWindow(s.id)}
                onFocusWindow={handleFocusWindow}
                onKill={() => handleKillLocal(s.id)}
              />
            ))}
          </Section>
        )}

        {/* Agent Connections */}
        {connectedAgents.length > 0 && (
          <Section
            title="Agent Connections"
            icon={<Server size={14} />}
            count={connectedAgents.length}
            onKillAll={handleKillAllAgents}
          >
            {connectedAgents.map((a) => (
              <ConnectionRow
                key={a.id}
                icon={<Server size={14} />}
                title={a.name}
                badge="connected"
                meta={
                  <AgentVersionBadge
                    version={a.capabilities?.agentVersion}
                    state={resolveAgentUpdateState(a.capabilities?.agentVersion, desktopVersion)}
                    showLabel
                    data-testid={`oc-agent-version-${a.id}`}
                  />
                }
                actions={
                  // Two distinct teardown intents mirroring the agent header
                  // (G9, #1237/#1277). Disconnect detaches the transport but keeps
                  // persistent remote sessions running; Shutdown stops them and
                  // reports the count. Both use the async Button for pending/error
                  // feedback; Shutdown adds a success toast.
                  <div className="oc-row__actions">
                    <Tooltip
                      content="Detach transport — keep persistent remote sessions"
                      side="top"
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Unplug size={14} />}
                        onClick={() => handleKillAgent(a.id)}
                        aria-label={`Disconnect (detach) ${a.name}`}
                        data-testid={`oc-agent-disconnect-${a.id}`}
                      >
                        Disconnect
                      </Button>
                    </Tooltip>
                    <ConfirmButton
                      icon={<Power size={14} />}
                      ariaLabel={`Shutdown (stop remote) ${a.name}`}
                      tooltip="Stop remote sessions and disconnect"
                      data-testid={`oc-agent-shutdown-${a.id}`}
                      confirmTitle={`Shut down ${a.name}?`}
                      confirmMessage={`This stops all remote sessions on “${a.name}” and disconnects. This cannot be undone.`}
                      confirmLabel="Shutdown"
                      confirmTestId={`oc-agent-shutdown-${a.id}-confirm`}
                      onConfirm={() => handleShutdownAgent(a.id)}
                    >
                      Shutdown
                    </ConfirmButton>
                  </div>
                }
              />
            ))}
          </Section>
        )}

        {/* Connections via each agent (proxy sessions opened from the desktop) */}
        {connectedAgents.map((a) => {
          const sessions = proxySessions[a.id] ?? [];
          if (sessions.length === 0) return null;
          return (
            <Section
              key={`proxy-sessions-${a.id}`}
              title={`Connections via ${a.name}`}
              icon={<Server size={14} />}
              count={sessions.length}
              onKillAll={() => handleKillAllProxy(a.id)}
            >
              {sessions.map((s) => (
                <ConnectionRow
                  key={s.id}
                  icon={s.connectionType === "ssh" ? <Server size={14} /> : <Terminal size={14} />}
                  title={s.title}
                  badge={s.alive ? "alive" : "dead"}
                  owningWindow={resolveOwningWindow(s.id)}
                  onFocusWindow={handleFocusWindow}
                  onKill={() => handleKillProxy(a.id, s.id)}
                />
              ))}
            </Section>
          );
        })}

        {/* Native sessions on each agent (reported by the agent itself) */}
        {connectedAgents.map((a) => {
          const sessions = agentSessions[a.id] ?? [];
          if (sessions.length === 0) return null;
          return (
            <Section
              key={`agent-sessions-${a.id}`}
              title={`Sessions on ${a.name}`}
              icon={<Terminal size={14} />}
              count={sessions.length}
              onKillAll={() => handleKillAllAgentSessions(a.id)}
            >
              {sessions.map((s) => (
                <ConnectionRow
                  key={s.sessionId}
                  icon={<Terminal size={14} />}
                  title={s.title}
                  badge={s.status === "attached" || s.status === "running" ? "alive" : "dead"}
                  onKill={() => handleKillAgentSession(a.id, s.sessionId)}
                />
              ))}
            </Section>
          );
        })}

        {/* SSH Tunnels */}
        {activeTunnels.length > 0 && (
          <Section
            title="SSH Tunnels"
            icon={<ArrowLeftRight size={14} />}
            count={activeTunnels.length}
            onKillAll={handleKillAllTunnels}
          >
            {activeTunnels.map((t) => {
              const state = tunnelStates[t.id];
              const status = state?.status ?? "connecting";
              // Map the tunnel status onto a badge; connecting/reconnecting share
              // the "connecting" badge, error surfaces its persisted message.
              const badge: BadgeVariant =
                status === "connected" ? "connected" : status === "error" ? "error" : "connecting";
              return (
                <ConnectionRow
                  key={t.id}
                  icon={<ArrowLeftRight size={14} />}
                  title={t.name}
                  detail={status === "error" ? state?.error : undefined}
                  badge={badge}
                  onKill={() => handleKillTunnel(t.id)}
                  killLabel="Stop"
                />
              );
            })}
          </Section>
        )}

        {/* Transfers — live in-flight SFTP transfers (#1247), each with an
            inline progress bar and a Cancel action. */}
        {transferList.length > 0 && (
          <Section
            title="Transfers"
            icon={<ArrowDownUp size={14} />}
            count={transferList.length}
            onKillAll={handleCancelAllTransfers}
            killAllLabel="Cancel All"
            data-testid="open-connections-transfers-section"
          >
            {transferList.map((t) => (
              <TransferRow
                key={t.transferId}
                transfer={t}
                onCancel={() => handleCancelTransfer(t.transferId)}
              />
            ))}
          </Section>
        )}

        {/* SFTP — one row per live backend session (#1241). Orphaned sessions
            (owning tab gone) surface with a warning badge so nothing is ever
            invisible/unkillable. */}
        {sftpSessionEntries.length > 0 && (
          <Section
            title="SFTP"
            icon={<FolderOpen size={14} />}
            count={sftpSessionEntries.length}
            onKillAll={handleKillAllSftp}
            data-testid="open-connections-sftp-section"
          >
            {sftpSessionEntries.map((s) => (
              <ConnectionRow
                key={s.id}
                icon={<FolderOpen size={14} />}
                title={s.hostLabel}
                detail={s.orphaned ? "orphaned — owning tab closed" : undefined}
                badge={s.orphaned ? "orphaned" : "connected"}
                onKill={() => handleKillSftp(s.id)}
              />
            ))}
          </Section>
        )}

        {/* Monitoring — one row per monitored host (#1231, audit gap G6). */}
        {openMonitors.length > 0 && (
          <Section
            title="Monitoring"
            icon={<Activity size={14} />}
            count={openMonitors.length}
            onKillAll={() => disconnectMonitoring()}
          >
            {openMonitors.map((m) => (
              <ConnectionRow
                key={m.key}
                icon={<MonitorStop size={14} />}
                title={m.host ?? m.key}
                detail={monitorRowDetail(m)}
                badge={monitorRowBadge(m)}
                onKill={() => disconnectMonitoring(m.key)}
                actions={
                  <MonitorRowActions
                    entry={m}
                    onTogglePaused={handleToggleMonitorPaused}
                    onSetInterval={handleSetMonitorInterval}
                    onRetry={handleRetryMonitor}
                  />
                }
              />
            ))}
          </Section>
        )}

        {/* HTTP Monitors (backend-owned polling loops) */}
        {httpMonitors.length > 0 && (
          <Section
            title="HTTP Monitors"
            icon={<Globe size={14} />}
            count={httpMonitors.length}
            onKillAll={handleStopAllHttpMonitors}
            killAllLabel="Stop All"
            data-testid="open-connections-http-monitors-section"
          >
            {httpMonitors.map((m) => (
              <ConnectionRow
                key={m.config.id}
                icon={<Globe size={14} />}
                title={m.config.url}
                badge={
                  !m.running
                    ? "stopped"
                    : m.paused
                      ? "paused"
                      : m.lastResult
                        ? m.lastResult.ok
                          ? "up"
                          : "down"
                        : "connecting"
                }
                onKill={() => handleStopHttpMonitor(m.config.id)}
                killLabel="Stop"
              />
            ))}
          </Section>
        )}

        {/* X Servers (the single shared X server, or a Set up affordance) */}
        {(showXServer || showXServerSetup) && (
          <Section
            title="X Servers"
            icon={<MonitorCog size={14} />}
            count={showXServer ? 1 : 0}
            onKillAll={showXServer && xServerManaged ? handleStopXServer : undefined}
            killAllLabel="Stop"
            data-testid="open-connections-x-servers-section"
          >
            {showXServer && xServer ? (
              <ConnectionRow
                icon={<MonitorCog size={14} />}
                title={xServerManaged ? "VcXsrv" : "External X server"}
                detail={xServerDetail}
                badge={xServerManaged ? "managed" : "external"}
                onKill={xServerManaged ? handleStopXServer : undefined}
                killLabel="Stop"
                data-testid="open-connections-x-server-row"
                killTestId="open-connections-x-server-stop"
              />
            ) : (
              <div className="oc-row" data-testid="open-connections-x-server-empty">
                <span className="oc-row__icon">
                  <MonitorCog size={14} />
                </span>
                <span className="oc-row__title oc-row__title--muted">No X server</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setXServerSetupOpen(true)}
                  data-testid="open-connections-x-server-setup"
                >
                  Set up
                </Button>
              </div>
            )}
          </Section>
        )}
      </div>

      <XServerSetupDialog
        open={xServerSetupOpen}
        onOpenChange={setXServerSetupOpen}
        onProvisioned={(report) => setXServer(report)}
      />
    </Modal>
  );
}

// ── Internal sub-components ───────────────────────────────────────────────

interface ConfirmButtonProps {
  children: React.ReactNode;
  /** Accessible label for the trigger button. */
  ariaLabel: string;
  /** Tooltip content for the trigger. */
  tooltip: string;
  /** Optional leading icon. */
  icon?: React.ReactNode;
  /** Extra class on the trigger button. */
  className?: string;
  /** Test hook for the trigger button. */
  "data-testid"?: string;
  confirmTitle: string;
  confirmMessage: string;
  confirmLabel: string;
  /** Test hook for the confirmation dialog. */
  confirmTestId?: string;
  onConfirm: () => void | Promise<void>;
}

/**
 * A danger action button that confirms before running its irreversible teardown
 * (#1343). Shared by the section "Kill All" controls and the agent "Shutdown"
 * action so the confirm-then-run pattern lives in one place. Keeps the trigger
 * tooltip and the async {@link Button} feedback on the confirmed path.
 */
function ConfirmButton({
  children,
  ariaLabel,
  tooltip,
  icon,
  className,
  "data-testid": testId,
  confirmTitle,
  confirmMessage,
  confirmLabel,
  confirmTestId,
  onConfirm,
}: ConfirmButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <Tooltip content={tooltip} side="top">
        <Button
          variant="danger"
          size="sm"
          icon={icon}
          className={className}
          onClick={() => setConfirmOpen(true)}
          aria-label={ariaLabel}
          data-testid={testId}
        >
          {children}
        </Button>
      </Tooltip>
      <ConfirmDialog
        open={confirmOpen}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={confirmLabel}
        onConfirm={() => {
          setConfirmOpen(false);
          void onConfirm();
        }}
        onCancel={() => setConfirmOpen(false)}
        data-testid={confirmTestId}
      />
    </>
  );
}

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  count: number;
  /** When omitted, no bulk-action button is rendered (nothing to stop). */
  onKillAll?: () => void | Promise<void>;
  /** Label for the bulk-action button (defaults to "Kill All"). */
  killAllLabel?: string;
  "data-testid"?: string;
  children: React.ReactNode;
}

function Section({
  title,
  count,
  onKillAll,
  killAllLabel = "Kill All",
  "data-testid": testId,
  children,
}: SectionProps) {
  // Bulk teardown is irreversible — confirm before running it (#1343).
  const noun = count === 1 ? "item" : "items";
  return (
    <div data-testid={testId}>
      <div className="oc-section__header">
        <span className="oc-section__title">{title}</span>
        {count > 0 && <span className="oc-section__count">{count}</span>}
        {onKillAll && (
          <ConfirmButton
            className="oc-section__kill-all"
            ariaLabel={`${killAllLabel} ${title}`}
            tooltip={`${killAllLabel} ${title}`}
            confirmTitle={`${killAllLabel} — ${title}?`}
            confirmMessage={`This will stop ${count} ${noun} in “${title}”. This cannot be undone.`}
            confirmLabel={killAllLabel}
            confirmTestId={testId ? `${testId}-confirm` : undefined}
            onConfirm={onKillAll}
          >
            {killAllLabel}
          </ConfirmButton>
        )}
      </div>
      {children}
    </div>
  );
}

type BadgeVariant =
  | "alive"
  | "dead"
  | "connected"
  | "connecting"
  | "reconnecting"
  | "managed"
  | "external"
  | "up"
  | "down"
  | "paused"
  | "stopped"
  | "orphaned"
  | "spawned"
  | "error";

interface TransferRowProps {
  transfer: TransferState;
  onCancel: () => void | Promise<void>;
}

/**
 * A single in-flight SFTP transfer row: a direction icon, the file name, an
 * inline {@link Progress} bar, a live byte/percentage label, and a Cancel
 * action. `total === 0` means an unknown size — render an indeterminate bar and
 * show only the transferred bytes (no percentage or denominator).
 */
function TransferRow({ transfer, onCancel }: TransferRowProps) {
  const { direction, fileName, transferred, total } = transfer;
  const indeterminate = total <= 0;
  const pct = indeterminate ? 0 : Math.round((transferred / total) * 100);
  const label = indeterminate
    ? formatBytes(transferred)
    : `${pct}% · ${formatBytes(transferred)} / ${formatBytes(total)}`;

  return (
    <div className="oc-row oc-transfer" data-testid="open-connections-transfer">
      <span className="oc-row__icon">
        {direction === "download" ? <Download size={14} /> : <Upload size={14} />}
      </span>
      <div className="oc-transfer__body">
        <span className="oc-row__title" title={fileName}>
          {fileName}
        </span>
        <Progress
          className="oc-transfer__progress"
          value={transferred}
          max={total}
          indeterminate={indeterminate}
          label={`${direction === "download" ? "Downloading" : "Uploading"} ${fileName}`}
        />
        <span className="oc-transfer__meta">{label}</span>
      </div>
      <Button
        variant="danger"
        size="sm"
        className="oc-row__kill"
        icon={<Ban size={14} />}
        onClick={() => onCancel()}
        aria-label={`Cancel transfer of ${fileName}`}
      >
        Cancel
      </Button>
    </div>
  );
}

/**
 * The window that owns a session, resolved from the backend ownership map for
 * the owning-window badge / focus affordance (#1926).
 */
interface OwningWindow {
  /** The owning window's runtime label (`main`, `win-1`, …). */
  label: string;
  /** Human-readable name, e.g. "Window 2". */
  name: string;
}

interface ConnectionRowProps {
  icon: React.ReactNode;
  title: string;
  /** Secondary line of context (e.g. the X display number). */
  detail?: string;
  badge: BadgeVariant;
  /** Extra info rendered between the title and the status badge (e.g. agent version). */
  meta?: React.ReactNode;
  /**
   * The window owning this row's session (#1926). When set, the row renders a
   * clickable "Window N" chip that focuses that window. Null/undefined for
   * single-window mode or an unclaimed session — the row then shows no chip.
   */
  owningWindow?: OwningWindow | null;
  /** Bring the owning window to the foreground (#1926). */
  onFocusWindow?: (label: string) => void | Promise<void>;
  /** When omitted, no per-row kill button is rendered. */
  onKill?: () => void | Promise<void>;
  /** Label for the kill button (defaults to "Kill"). */
  killLabel?: string;
  "data-testid"?: string;
  /** data-testid forwarded to the kill button. */
  killTestId?: string;
  /**
   * Custom trailing actions, rendered in place of the default kill button. Used
   * by rows that expose more than one teardown intent (e.g. an agent's
   * Disconnect vs Shutdown). When set, `onKill` is ignored.
   */
  actions?: React.ReactNode;
}

function ConnectionRow({
  icon,
  title,
  detail,
  badge,
  meta,
  owningWindow,
  onFocusWindow,
  onKill,
  killLabel = "Kill",
  "data-testid": testId,
  killTestId,
  actions,
}: ConnectionRowProps) {
  return (
    <div className="oc-row" data-testid={testId}>
      <span className="oc-row__icon">{icon}</span>
      <span className="oc-row__title" title={title}>
        {title}
        {detail && <span className="oc-row__detail">{detail}</span>}
      </span>
      {meta}
      {owningWindow && (
        <Tooltip content={`Focus ${owningWindow.name}`} side="top">
          <Button
            variant="ghost"
            size="sm"
            className="oc-row__window"
            icon={<AppWindow size={12} />}
            onClick={() => onFocusWindow?.(owningWindow.label)}
            aria-label={`Focus ${owningWindow.name}`}
            data-testid="oc-row-window"
          >
            {owningWindow.name}
          </Button>
        </Tooltip>
      )}
      <span className={`oc-row__badge oc-row__badge--${badge}`}>{badge}</span>
      {actions ??
        (onKill && (
          <Button
            variant="danger"
            size="sm"
            className="oc-row__kill"
            onClick={() => onKill()}
            data-testid={killTestId}
          >
            {killLabel}
          </Button>
        ))}
    </div>
  );
}

/** Format a monitoring refresh interval (ms) as a compact label like "2s" (#1233). */
function formatMonitorInterval(intervalMs: number): string {
  return `${Math.round(intervalMs / 1000)}s`;
}

/** Human-readable secondary line for a monitoring row (#1233). */
function monitorRowDetail(m: MonitoringEntry): string | undefined {
  if (m.paused) return "paused — collection stopped";
  if (m.status === "offline") return "offline — connection lost";
  if (m.status === "stale") return "stale — connection dropped";
  return `every ${formatMonitorInterval(m.intervalMs)}`;
}

/** Status badge variant for a monitoring row (#1233). */
function monitorRowBadge(m: MonitoringEntry): BadgeVariant {
  if (m.paused) return "paused";
  if (m.status === "offline") return "error";
  if (m.status === "stale") return "reconnecting";
  return "connected";
}

/** Props for {@link MonitorRowActions}. */
interface MonitorRowActionsProps {
  entry: MonitoringEntry;
  onTogglePaused: (key: string, paused: boolean) => void | Promise<void>;
  onSetInterval: (key: string, intervalMs: number) => void | Promise<void>;
  onRetry: (key: string) => void | Promise<void>;
}

/**
 * Per-host monitoring controls for an Open Connections row: Pause/Resume, an
 * interval selector, and (when offline) a Retry — all composed from shared
 * primitives with feedback-on-every-action handled by the parent (#1233).
 */
function MonitorRowActions({
  entry,
  onTogglePaused,
  onSetInterval,
  onRetry,
}: MonitorRowActionsProps) {
  const paused = entry.paused;
  const isOffline = entry.status === "offline";
  return (
    <span className="oc-row__actions">
      {isOffline && (
        <Tooltip content="Retry monitor" side="top">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onRetry(entry.key)}
            aria-label="Retry monitor"
            data-testid={`monitor-retry-${entry.key}`}
          >
            <RotateCw size={14} />
          </Button>
        </Tooltip>
      )}
      <Tooltip content={paused ? "Resume monitoring" : "Pause monitoring"} side="top">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onTogglePaused(entry.key, !paused)}
          aria-label={paused ? "Resume monitoring" : "Pause monitoring"}
          data-testid={paused ? `monitor-resume-${entry.key}` : `monitor-pause-${entry.key}`}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </Button>
      </Tooltip>
      <DropdownMenu.Root>
        <Tooltip content="Refresh interval" side="top">
          <DropdownMenu.Trigger asChild>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Set refresh interval"
              data-testid={`monitor-interval-${entry.key}`}
            >
              <Timer size={14} />
              {formatMonitorInterval(entry.intervalMs)}
            </Button>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="monitoring-menu__content"
            side="bottom"
            align="end"
            sideOffset={4}
          >
            <DropdownMenu.Label className="monitoring-menu__label monitoring-menu__interval-label">
              Refresh interval
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={String(entry.intervalMs)}
              onValueChange={(v) => onSetInterval(entry.key, Number(v))}
            >
              {MONITORING_INTERVAL_OPTIONS.map((opt) => (
                <DropdownMenu.RadioItem
                  key={opt}
                  className="monitoring-menu__action monitoring-menu__radio"
                  value={String(opt)}
                  data-testid={`monitor-interval-${entry.key}-${opt}`}
                >
                  <DropdownMenu.ItemIndicator className="monitoring-menu__radio-indicator">
                    <Check size={14} />
                  </DropdownMenu.ItemIndicator>
                  <span className="monitoring-menu__radio-label">
                    Refresh every {formatMonitorInterval(opt)}
                  </span>
                  {opt === DEFAULT_MONITORING_INTERVAL_MS && (
                    <span className="monitoring-menu__radio-default">default</span>
                  )}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}
