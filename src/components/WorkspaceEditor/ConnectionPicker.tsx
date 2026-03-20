import { useState, useMemo } from "react";
import { X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { WorkspaceTabDef } from "@/types/workspace";

interface ConnectionPickerProps {
  onSelect: (tab: WorkspaceTabDef) => void;
  onCancel: () => void;
}

export function ConnectionPicker({ onSelect, onCancel }: ConnectionPickerProps) {
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
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

  const handleSelectConnection = (connectionId: string, connectionName: string) => {
    onSelect({
      connectionRef: connectionId,
      title: connectionName,
    });
  };

  const handleSelectInline = () => {
    onSelect({
      inlineConfig: { type: "local", config: {} },
      title: "Local Shell",
    });
  };

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
          placeholder="Search connections..."
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

          {filtered.length === 0 && (
            <div className="connection-picker__empty">No connections match your search.</div>
          )}
        </div>
      </div>
    </div>
  );
}
