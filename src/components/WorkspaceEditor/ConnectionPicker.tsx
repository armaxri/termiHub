import { useState, useMemo } from "react";
import { X, AlertTriangle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { WorkspaceTabDef } from "@/types/workspace";

interface ConnectionPickerProps {
  onSelect: (tab: WorkspaceTabDef) => void;
  onCancel: () => void;
}

export function ConnectionPicker({ onSelect, onCancel }: ConnectionPickerProps) {
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
  const remoteAgents = useAppStore((s) => s.remoteAgents);
  const agentDefinitions = useAppStore((s) => s.agentDefinitions);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    return connections.filter(
      (c) => c.name.toLowerCase().includes(term) || c.config.type.toLowerCase().includes(term)
    );
  }, [connections, search]);

  const grouped = useMemo(() => {
    const groups: Record<string, typeof filtered> = {};
    const ungrouped: typeof filtered = [];

    for (const conn of filtered) {
      if (conn.folderId) {
        const folder = folders.find((f) => f.id === conn.folderId);
        const folderName = folder?.name ?? "Unknown Folder";
        if (!groups[folderName]) groups[folderName] = [];
        groups[folderName].push(conn);
      } else {
        ungrouped.push(conn);
      }
    }

    return { groups, ungrouped };
  }, [filtered, folders]);

  const filteredAgents = useMemo(() => {
    if (!search) return remoteAgents;
    const term = search.toLowerCase();
    return remoteAgents.filter((a) => a.name.toLowerCase().includes(term));
  }, [remoteAgents, search]);

  const handleSelectConnection = (connectionId: string, connectionName: string) => {
    onSelect({
      connectionRef: connectionId,
      title: connectionName,
    });
  };

  const handleSelectAgentDef = (agentId: string, definitionId: string, definitionName: string) => {
    onSelect({
      agentRef: { agentId, definitionId },
      title: definitionName,
    });
  };

  const handleSelectInline = () => {
    onSelect({
      inlineConfig: { type: "local", config: {} },
      title: "Local Shell",
    });
  };

  const hasConnections = filtered.length > 0;
  const hasAgents = filteredAgents.length > 0;

  return (
    <div className="connection-picker__overlay" data-testid="connection-picker">
      <div className="connection-picker">
        <div className="connection-picker__header">
          <h3 className="connection-picker__title">Add Connection</h3>
          <button
            className="connection-picker__close"
            onClick={onCancel}
            data-testid="connection-picker-close"
          >
            <X size={16} />
          </button>
        </div>

        <input
          className="connection-picker__search"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search connections…"
          autoFocus
          data-testid="connection-picker-search"
        />

        <div className="connection-picker__list">
          <button
            className="connection-picker__item connection-picker__item--inline"
            onClick={handleSelectInline}
            data-testid="connection-picker-inline"
          >
            <span className="connection-picker__item-name">Local Shell</span>
            <span className="connection-picker__item-type">inline</span>
          </button>

          {grouped.ungrouped.map((conn) => (
            <button
              key={conn.id}
              className="connection-picker__item"
              onClick={() => handleSelectConnection(conn.id, conn.name)}
              data-testid={`connection-picker-item-${conn.id}`}
            >
              <span className="connection-picker__item-name">{conn.name}</span>
              <span className="connection-picker__item-type">{conn.config.type}</span>
            </button>
          ))}

          {Object.entries(grouped.groups).map(([folderName, conns]) => (
            <div key={folderName} className="connection-picker__group">
              <div className="connection-picker__group-name">{folderName}</div>
              {conns.map((conn) => (
                <button
                  key={conn.id}
                  className="connection-picker__item"
                  onClick={() => handleSelectConnection(conn.id, conn.name)}
                  data-testid={`connection-picker-item-${conn.id}`}
                >
                  <span className="connection-picker__item-name">{conn.name}</span>
                  <span className="connection-picker__item-type">{conn.config.type}</span>
                </button>
              ))}
            </div>
          ))}

          {hasAgents && (
            <div className="connection-picker__group">
              <div className="connection-picker__group-name">Remote Agents</div>
              {filteredAgents.map((agent) => {
                const isConnected = agent.connectionState === "connected";
                const defs = agentDefinitions[agent.id] ?? [];

                if (!isConnected) {
                  return (
                    <div
                      key={agent.id}
                      className="connection-picker__agent-offline"
                      data-testid={`connection-picker-agent-offline-${agent.id}`}
                    >
                      <div className="connection-picker__agent-header">
                        <span className="connection-picker__item-name">{agent.name}</span>
                        <AlertTriangle
                          size={13}
                          className="connection-picker__agent-warning-icon"
                        />
                      </div>
                      <span className="connection-picker__agent-warning">
                        Agent not connected — available connections cannot be displayed
                      </span>
                    </div>
                  );
                }

                if (defs.length === 0) {
                  return (
                    <div
                      key={agent.id}
                      className="connection-picker__agent-offline"
                      data-testid={`connection-picker-agent-empty-${agent.id}`}
                    >
                      <span className="connection-picker__item-name">{agent.name}</span>
                      <span className="connection-picker__agent-warning">
                        No connection definitions configured on this agent
                      </span>
                    </div>
                  );
                }

                return (
                  <div key={agent.id} className="connection-picker__agent-group">
                    <div className="connection-picker__agent-name">{agent.name}</div>
                    {defs.map((def) => (
                      <button
                        key={def.id}
                        className="connection-picker__item connection-picker__item--agent"
                        onClick={() => handleSelectAgentDef(agent.id, def.id, def.name)}
                        data-testid={`connection-picker-agent-def-${def.id}`}
                      >
                        <span className="connection-picker__item-name">{def.name}</span>
                        <span className="connection-picker__item-type">{def.sessionType}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {!hasConnections && !hasAgents && (
            <div className="connection-picker__empty">No connections match your search.</div>
          )}
          {!hasConnections && filtered.length === 0 && connections.length > 0 && hasAgents && (
            <div className="connection-picker__empty">No saved connections match your search.</div>
          )}
        </div>
      </div>
    </div>
  );
}
