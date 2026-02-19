/**
 * Agent folder node in the sidebar.
 *
 * Renders a remote agent as an expandable folder with connection state,
 * child sessions, and saved definitions.
 */

import { useState, useCallback } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ChevronDown,
  ChevronRight,
  Server,
  Plus,
  Pencil,
  Trash2,
  Play,
  Square,
  RefreshCw,
  Terminal,
  Cable,
  Upload,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { RemoteAgentDefinition } from "@/types/connection";
import { AgentSessionInfo, AgentDefinitionInfo } from "@/services/api";
import { AgentSetupDialog } from "./AgentSetupDialog";

interface AgentNodeProps {
  agent: RemoteAgentDefinition;
}

/** State dot colors matching the tab state dot pattern. */
const STATE_DOT_COLORS: Record<string, string> = {
  connected: "#0dbc79",
  connecting: "#e5e510",
  reconnecting: "#e5e510",
  disconnected: "#cd3131",
};

export function AgentNode({ agent }: AgentNodeProps) {
  const toggleRemoteAgent = useAppStore((s) => s.toggleRemoteAgent);
  const connectRemoteAgent = useAppStore((s) => s.connectRemoteAgent);
  const disconnectRemoteAgent = useAppStore((s) => s.disconnectRemoteAgent);
  const deleteRemoteAgent = useAppStore((s) => s.deleteRemoteAgent);
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const requestPassword = useAppStore((s) => s.requestPassword);
  const addTab = useAppStore((s) => s.addTab);
  const agentSessions = useAppStore((s) => s.agentSessions[agent.id] ?? []);
  const agentDefinitions = useAppStore((s) => s.agentDefinitions[agent.id] ?? []);
  const refreshAgentSessions = useAppStore((s) => s.refreshAgentSessions);

  const [connecting, setConnecting] = useState(false);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);

  const isConnected = agent.connectionState === "connected";
  const Chevron = agent.isExpanded ? ChevronDown : ChevronRight;

  const handleConnect = useCallback(async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      let password: string | undefined;
      if (agent.config.authMethod === "password" && !agent.config.password) {
        const result = await requestPassword(agent.config.host, agent.config.username);
        if (!result) {
          setConnecting(false);
          return;
        }
        password = result;
      }
      await connectRemoteAgent(agent.id, password);
    } finally {
      setConnecting(false);
    }
  }, [agent, connectRemoteAgent, requestPassword, connecting]);

  const handleDisconnect = useCallback(() => {
    disconnectRemoteAgent(agent.id);
  }, [agent.id, disconnectRemoteAgent]);

  const handleNewShellSession = useCallback(() => {
    const defaultShell = agent.capabilities?.availableShells?.[0];
    addTab(defaultShell ? `Shell: ${defaultShell}` : "Shell", "remote-session", {
      type: "remote-session",
      config: {
        agentId: agent.id,
        sessionType: "shell",
        shell: defaultShell,
        persistent: false,
      },
    });
  }, [agent, addTab]);

  const handleNewSerialSession = useCallback(() => {
    const defaultPort = agent.capabilities?.availableSerialPorts?.[0];
    if (!defaultPort) return;
    addTab(`Serial: ${defaultPort}`, "remote-session", {
      type: "remote-session",
      config: {
        agentId: agent.id,
        sessionType: "serial",
        serialPort: defaultPort,
        persistent: false,
      },
    });
  }, [agent, addTab]);

  const handleAttachSession = useCallback(
    (session: AgentSessionInfo) => {
      addTab(session.title || `Session: ${session.sessionId}`, "remote-session", {
        type: "remote-session",
        config: {
          agentId: agent.id,
          sessionType: session.type as "shell" | "serial",
          persistent: true,
          title: session.title,
        },
      });
    },
    [agent.id, addTab]
  );

  const handleOpenDefinition = useCallback(
    (def: AgentDefinitionInfo) => {
      addTab(def.name, "remote-session", {
        type: "remote-session",
        config: {
          agentId: agent.id,
          sessionType: def.sessionType as "shell" | "serial",
          shell: (def.config as Record<string, unknown>).shell as string | undefined,
          serialPort: (def.config as Record<string, unknown>).port as string | undefined,
          persistent: def.persistent,
          title: def.name,
        },
      });
    },
    [agent.id, addTab]
  );

  const handleRefresh = useCallback(() => {
    refreshAgentSessions(agent.id);
  }, [agent.id, refreshAgentSessions]);

  return (
    <div className="connection-list__group">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="connection-list__group-header">
            <button
              className="connection-list__group-toggle"
              onClick={() => toggleRemoteAgent(agent.id)}
            >
              <Chevron size={16} className="connection-tree__chevron" />
              <span
                className="agent-node__state-dot"
                style={{ backgroundColor: STATE_DOT_COLORS[agent.connectionState] ?? "#cd3131" }}
                title={agent.connectionState}
              />
              <Server size={14} />
              <span className="connection-list__group-title">{agent.name}</span>
            </button>
            {isConnected && (
              <div className="connection-list__group-actions">
                <button
                  className="connection-list__add-btn"
                  onClick={handleNewShellSession}
                  title="New Shell Session"
                >
                  <Plus size={16} />
                </button>
              </div>
            )}
          </div>
        </ContextMenu.Trigger>

        <ContextMenu.Portal>
          <ContextMenu.Content className="context-menu__content">
            {!isConnected ? (
              <>
                <ContextMenu.Item className="context-menu__item" onSelect={handleConnect}>
                  <Play size={14} />
                  Connect
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={() => setSetupDialogOpen(true)}
                >
                  <Upload size={14} />
                  Setup Agent...
                </ContextMenu.Item>
              </>
            ) : (
              <>
                <ContextMenu.Item className="context-menu__item" onSelect={handleDisconnect}>
                  <Square size={14} />
                  Disconnect
                </ContextMenu.Item>
                <ContextMenu.Item className="context-menu__item" onSelect={handleRefresh}>
                  <RefreshCw size={14} />
                  Refresh Sessions
                </ContextMenu.Item>
                <ContextMenu.Separator className="context-menu__separator" />
                <ContextMenu.Item className="context-menu__item" onSelect={handleNewShellSession}>
                  <Terminal size={14} />
                  New Shell Session
                </ContextMenu.Item>
                {(agent.capabilities?.availableSerialPorts?.length ?? 0) > 0 && (
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={handleNewSerialSession}
                  >
                    <Cable size={14} />
                    New Serial Session
                  </ContextMenu.Item>
                )}
              </>
            )}
            <ContextMenu.Separator className="context-menu__separator" />
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => openConnectionEditorTab(agent.id)}
            >
              <Pencil size={14} />
              Edit
            </ContextMenu.Item>
            <ContextMenu.Item
              className="context-menu__item context-menu__item--danger"
              onSelect={() => deleteRemoteAgent(agent.id)}
            >
              <Trash2 size={14} />
              Delete
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <AgentSetupDialog open={setupDialogOpen} onOpenChange={setSetupDialogOpen} agent={agent} />

      {agent.isExpanded && (
        <div className="connection-list__tree">
          {isConnected ? (
            <>
              {agentSessions.length === 0 && agentDefinitions.length === 0 && (
                <div className="agent-node__hint" style={{ paddingLeft: 32 }}>
                  No sessions. Right-click to create one.
                </div>
              )}
              {agentSessions.map((session) => (
                <button
                  key={session.sessionId}
                  className="connection-tree__item"
                  style={{ paddingLeft: 32 }}
                  onDoubleClick={() => handleAttachSession(session)}
                  title={`${session.title} (${session.status})`}
                >
                  {session.type === "serial" ? <Cable size={14} /> : <Terminal size={14} />}
                  <span className="connection-tree__label">{session.title}</span>
                  <span className="connection-tree__type">{session.status}</span>
                </button>
              ))}
              {agentDefinitions.length > 0 && agentSessions.length > 0 && (
                <div
                  className="agent-node__hint"
                  style={{ paddingLeft: 32, marginTop: 4, marginBottom: 2 }}
                >
                  Saved Definitions
                </div>
              )}
              {agentDefinitions.map((def) => (
                <button
                  key={def.id}
                  className="connection-tree__item"
                  style={{ paddingLeft: 32 }}
                  onDoubleClick={() => handleOpenDefinition(def)}
                  title={`${def.name} (${def.sessionType}${def.persistent ? ", persistent" : ""})`}
                >
                  {def.sessionType === "serial" ? <Cable size={14} /> : <Terminal size={14} />}
                  <span className="connection-tree__label">{def.name}</span>
                  <span className="connection-tree__type">{def.sessionType}</span>
                </button>
              ))}
            </>
          ) : (
            <div className="agent-node__hint" style={{ paddingLeft: 32 }}>
              Connect to view sessions
            </div>
          )}
        </div>
      )}
    </div>
  );
}
