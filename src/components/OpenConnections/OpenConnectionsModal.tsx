import { useEffect, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Terminal,
  Server,
  ArrowLeftRight,
  FolderOpen,
  Activity,
  X,
  MonitorStop,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import {
  listLocalSessions,
  listAgentSessions,
  closeTerminal,
  closeAgentSession,
  LocalSessionInfo,
  AgentSessionInfo,
} from "@/services/api";
import { TunnelState } from "@/types/tunnel";
import "./OpenConnectionsModal.css";

interface OpenConnectionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AgentSessionsState {
  [agentId: string]: AgentSessionInfo[];
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
  const sftpConnectedHost = useAppStore((s) => s.sftpConnectedHost);
  const disconnectSftp = useAppStore((s) => s.disconnectSftp);
  const monitoringHost = useAppStore((s) => s.monitoringHost);
  const disconnectMonitoring = useAppStore((s) => s.disconnectMonitoring);

  const [localSessions, setLocalSessions] = useState<LocalSessionInfo[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSessionsState>({});
  const [tunnelStates, setTunnelStates] = useState<TunnelState[]>([]);
  const [loading, setLoading] = useState(false);

  const connectedAgents = remoteAgents.filter((a) => a.connectionState === "connected");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [locals, ...agentSessionArrays] = await Promise.all([
        listLocalSessions(),
        ...connectedAgents.map((a) => listAgentSessions(a.id).catch(() => [])),
      ]);

      setLocalSessions(locals.filter((s) => !s.agentId));

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
      // Tunnel states are already in the store; grab them.
      import("@/services/tunnelApi").then(({ getTunnelStatuses }) => {
        getTunnelStatuses()
          .then(setTunnelStates)
          .catch(() => {});
      });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeTunnels = tunnels.filter((t) => {
    const state = tunnelStates.find((ts) => ts.tunnelId === t.id);
    return state && (state.status === "connected" || state.status === "connecting");
  });

  const totalCount =
    localSessions.length +
    connectedAgents.length +
    Object.values(agentSessions).reduce((s, arr) => s + arr.length, 0) +
    activeTunnels.length +
    (sftpConnectedHost ? 1 : 0) +
    (monitoringHost ? 1 : 0);

  const handleKillLocal = async (id: string) => {
    await closeTerminal(id).catch(() => {});
    setLocalSessions((prev) => prev.filter((s) => s.id !== id));
  };

  const handleKillAllLocal = async () => {
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

  const handleKillTunnel = async (tunnelId: string) => {
    await stopTunnel(tunnelId);
    setTunnelStates((prev) => prev.filter((ts) => ts.tunnelId !== tunnelId));
  };

  const handleKillAllTunnels = async () => {
    await Promise.all(activeTunnels.map((t) => stopTunnel(t.id)));
    setTunnelStates([]);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="open-connections__overlay" />
        <Dialog.Content className="open-connections__content" aria-describedby={undefined}>
          <div className="open-connections__header">
            <Dialog.Title className="open-connections__title">
              Open Connections
              {totalCount > 0 && (
                <span className="oc-section__count" style={{ marginLeft: "8px" }}>
                  {totalCount}
                </span>
              )}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="open-connections__close" aria-label="Close">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="open-connections__body">
            {loading && totalCount === 0 && <div className="open-connections__empty">Loading…</div>}
            {!loading && totalCount === 0 && (
              <div className="open-connections__empty">No open connections.</div>
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

            {/* Sessions per Agent */}
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
                  const state = tunnelStates.find((ts) => ts.tunnelId === t.id);
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Internal sub-components ───────────────────────────────────────────────

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  count: number;
  onKillAll: () => void;
  children: React.ReactNode;
}

function Section({ title, count, onKillAll, children }: SectionProps) {
  return (
    <div>
      <div className="oc-section__header">
        <span className="oc-section__title">{title}</span>
        <span className="oc-section__count">{count}</span>
        <button className="oc-section__kill-all" onClick={onKillAll} title={`Kill all ${title}`}>
          Kill All
        </button>
      </div>
      {children}
    </div>
  );
}

type BadgeVariant = "alive" | "dead" | "connected" | "connecting";

interface ConnectionRowProps {
  icon: React.ReactNode;
  title: string;
  badge: BadgeVariant;
  onKill: () => void;
}

function ConnectionRow({ icon, title, badge, onKill }: ConnectionRowProps) {
  return (
    <div className="oc-row">
      <span className="oc-row__icon">{icon}</span>
      <span className="oc-row__title" title={title}>
        {title}
      </span>
      <span className={`oc-row__badge oc-row__badge--${badge}`}>{badge}</span>
      <button className="oc-row__kill" onClick={onKill}>
        Kill
      </button>
    </div>
  );
}
