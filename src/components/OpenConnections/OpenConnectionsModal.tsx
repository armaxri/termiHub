import { useEffect, useState, useCallback } from "react";
import {
  Terminal,
  Server,
  ArrowLeftRight,
  FolderOpen,
  Activity,
  MonitorStop,
  MonitorCog,
  Loader2,
} from "lucide-react";
import { Modal, Button, Tooltip } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import {
  listLocalSessions,
  listAgentSessions,
  closeTerminal,
  closeAgentSession,
  cancelConnecting,
  xServerStatus,
  xServerStop,
  LocalSessionInfo,
  AgentSessionInfo,
} from "@/services/api";
import { XServerStatusReport } from "@/types/xserver";
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
  const disconnectRemoteAgent = useAppStore((s) => s.disconnectRemoteAgent);
  const stopTunnel = useAppStore((s) => s.stopTunnel);
  const tunnels = useAppStore((s) => s.tunnels);
  // Live single source of truth for tunnel status (kept in sync by tunnel
  // events); the panel reads it directly so it never drifts from the sidebar.
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const sftpConnectedHost = useAppStore((s) => s.sftpConnectedHost);
  const disconnectSftp = useAppStore((s) => s.disconnectSftp);
  const monitoringHost = useAppStore((s) => s.monitoringHost);
  const disconnectMonitoring = useAppStore((s) => s.disconnectMonitoring);
  const rootPanel = useAppStore((s) => s.rootPanel);
  const terminalConnecting = useAppStore((s) => s.terminalConnecting);
  const closeTab = useAppStore((s) => s.closeTab);
  const markSessionKilled = useAppStore((s) => s.markSessionKilled);

  // Sessions still establishing their connection (visible as connecting tabs).
  // Cancelling aborts the in-flight handshake instead of waiting it out (#952).
  const connectingTabs = getAllLeaves(rootPanel)
    .flatMap((leaf) => leaf.tabs)
    .filter((tab) => terminalConnecting[tab.id]);

  const [localSessions, setLocalSessions] = useState<LocalSessionInfo[]>([]);
  const [proxySessions, setProxySessions] = useState<ProxySessionsState>({});
  const [agentSessions, setAgentSessions] = useState<AgentSessionsState>({});
  const [xServer, setXServer] = useState<XServerStatusReport | null>(null);
  const [xServerSetupOpen, setXServerSetupOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const connectedAgents = remoteAgents.filter((a) => a.connectionState === "connected");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [locals, xServerReport, ...agentSessionArrays] = await Promise.all([
        listLocalSessions(),
        xServerStatus().catch(() => null),
        ...connectedAgents.map((a) => listAgentSessions(a.id).catch(() => [])),
      ]);

      setLocalSessions(locals.filter((s) => !s.agentId));
      setXServer(xServerReport as XServerStatusReport | null);

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

  const activeTunnels = tunnels.filter((t) => {
    const state = tunnelStates[t.id];
    return state && (state.status === "connected" || state.status === "connecting");
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
    localSessions.length +
    connectedAgents.length +
    Object.values(proxySessions).reduce((s, arr) => s + arr.length, 0) +
    Object.values(agentSessions).reduce((s, arr) => s + arr.length, 0) +
    activeTunnels.length +
    (sftpConnectedHost ? 1 : 0) +
    (monitoringHost ? 1 : 0) +
    (showXServer ? 1 : 0);

  const handleCancelConnecting = async (tabId: string, panelId: string) => {
    await cancelConnecting(tabId).catch(() => {});
    closeTab(tabId, panelId);
  };

  const handleCancelAllConnecting = async () => {
    await Promise.all(connectingTabs.map((t) => cancelConnecting(t.id).catch(() => {})));
    connectingTabs.forEach((t) => closeTab(t.id, t.panelId));
  };

  const handleKillLocal = async (id: string) => {
    // Tag the kill as intentional so the terminal-exit handler suppresses the
    // "unexpected disconnect" overlay for the owning tab (#1121).
    markSessionKilled(id);
    await closeTerminal(id).catch(() => {});
    setLocalSessions((prev) => prev.filter((s) => s.id !== id));
  };

  const handleKillAllLocal = async () => {
    localSessions.forEach((s) => markSessionKilled(s.id));
    await Promise.all(localSessions.map((s) => closeTerminal(s.id).catch(() => {})));
    setLocalSessions([]);
  };

  const handleKillAgent = async (agentId: string) => {
    await disconnectRemoteAgent(agentId);
    setAgentSessions((prev) => {
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  };

  const handleKillAllAgents = async () => {
    await Promise.all(connectedAgents.map((a) => disconnectRemoteAgent(a.id)));
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

  const handleStopXServer = async () => {
    await xServerStop().catch(() => {});
    setXServer(null);
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

        {/* Local Sessions */}
        {localSessions.length > 0 && (
          <Section
            title="Local Sessions"
            icon={<Terminal size={14} />}
            count={localSessions.length}
            onKillAll={handleKillAllLocal}
          >
            {localSessions.map((s) => (
              <ConnectionRow
                key={s.id}
                icon={<Terminal size={14} />}
                title={s.title}
                badge={s.alive ? "alive" : "dead"}
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
                onKill={() => handleKillAgent(a.id)}
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
              return (
                <ConnectionRow
                  key={t.id}
                  icon={<ArrowLeftRight size={14} />}
                  title={t.name}
                  badge={state?.status === "connected" ? "connected" : "connecting"}
                  onKill={() => handleKillTunnel(t.id)}
                />
              );
            })}
          </Section>
        )}

        {/* SFTP */}
        {sftpConnectedHost && (
          <Section
            title="SFTP"
            icon={<FolderOpen size={14} />}
            count={1}
            onKillAll={disconnectSftp}
          >
            <ConnectionRow
              icon={<FolderOpen size={14} />}
              title={sftpConnectedHost}
              badge="connected"
              onKill={disconnectSftp}
            />
          </Section>
        )}

        {/* Monitoring */}
        {monitoringHost && (
          <Section
            title="Monitoring"
            icon={<Activity size={14} />}
            count={1}
            onKillAll={disconnectMonitoring}
          >
            <ConnectionRow
              icon={<MonitorStop size={14} />}
              title={monitoringHost}
              badge="connected"
              onKill={disconnectMonitoring}
            />
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
  return (
    <div data-testid={testId}>
      <div className="oc-section__header">
        <span className="oc-section__title">{title}</span>
        {count > 0 && <span className="oc-section__count">{count}</span>}
        {onKillAll && (
          <Tooltip content={`${killAllLabel} ${title}`} side="top">
            <Button
              variant="danger"
              size="sm"
              className="oc-section__kill-all"
              onClick={() => onKillAll()}
              aria-label={`${killAllLabel} ${title}`}
            >
              {killAllLabel}
            </Button>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
}

type BadgeVariant = "alive" | "dead" | "connected" | "connecting" | "managed" | "external";

interface ConnectionRowProps {
  icon: React.ReactNode;
  title: string;
  /** Secondary line of context (e.g. the X display number). */
  detail?: string;
  badge: BadgeVariant;
  /** When omitted, no per-row kill button is rendered. */
  onKill?: () => void | Promise<void>;
  /** Label for the kill button (defaults to "Kill"). */
  killLabel?: string;
  "data-testid"?: string;
  /** data-testid forwarded to the kill button. */
  killTestId?: string;
}

function ConnectionRow({
  icon,
  title,
  detail,
  badge,
  onKill,
  killLabel = "Kill",
  "data-testid": testId,
  killTestId,
}: ConnectionRowProps) {
  return (
    <div className="oc-row" data-testid={testId}>
      <span className="oc-row__icon">{icon}</span>
      <span className="oc-row__title" title={title}>
        {title}
        {detail && <span className="oc-row__detail">{detail}</span>}
      </span>
      <span className={`oc-row__badge oc-row__badge--${badge}`}>{badge}</span>
      {onKill && (
        <Button
          variant="danger"
          size="sm"
          className="oc-row__kill"
          onClick={() => onKill()}
          data-testid={killTestId}
        >
          {killLabel}
        </Button>
      )}
    </div>
  );
}
