import { useCallback } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  Terminal,
  Wifi,
  Cable,
  Globe,
  Plus,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { ConnectionType } from "@/types/terminal";
import { SavedConnection, ConnectionFolder } from "@/types/connection";
import "./ConnectionList.css";

const TYPE_ICONS: Record<ConnectionType, typeof Terminal> = {
  local: Terminal,
  ssh: Wifi,
  serial: Cable,
  telnet: Globe,
};

interface TreeNodeProps {
  folder: ConnectionFolder;
  connections: SavedConnection[];
  childFolders: ConnectionFolder[];
  allFolders: ConnectionFolder[];
  allConnections: SavedConnection[];
  onToggle: (folderId: string) => void;
  onConnect: (connection: SavedConnection) => void;
  onEdit: (connectionId: string) => void;
  depth: number;
}

function TreeNode({
  folder,
  connections,
  childFolders,
  allFolders,
  allConnections,
  onToggle,
  onConnect,
  onEdit,
  depth,
}: TreeNodeProps) {
  const Chevron = folder.isExpanded ? ChevronDown : ChevronRight;

  return (
    <div className="connection-tree__node">
      <button
        className="connection-tree__folder"
        onClick={() => onToggle(folder.id)}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <Chevron size={16} className="connection-tree__chevron" />
        <Folder size={16} />
        <span className="connection-tree__label">{folder.name}</span>
      </button>
      {folder.isExpanded && (
        <div className="connection-tree__children">
          {childFolders.map((child) => (
            <TreeNode
              key={child.id}
              folder={child}
              connections={allConnections.filter((c) => c.folderId === child.id)}
              childFolders={allFolders.filter((f) => f.parentId === child.id)}
              allFolders={allFolders}
              allConnections={allConnections}
              onToggle={onToggle}
              onConnect={onConnect}
              onEdit={onEdit}
              depth={depth + 1}
            />
          ))}
          {connections.map((conn) => (
            <ConnectionItem
              key={conn.id}
              connection={conn}
              depth={depth + 1}
              onConnect={onConnect}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ConnectionItemProps {
  connection: SavedConnection;
  depth: number;
  onConnect: (connection: SavedConnection) => void;
  onEdit: (connectionId: string) => void;
}

function ConnectionItem({ connection, depth, onConnect, onEdit }: ConnectionItemProps) {
  const Icon = TYPE_ICONS[connection.config.type];

  return (
    <button
      className="connection-tree__item"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      onDoubleClick={() => onConnect(connection)}
      onClick={() => onEdit(connection.id)}
      title={`Double-click to connect: ${connection.name}`}
    >
      <Icon size={16} />
      <span className="connection-tree__label">{connection.name}</span>
      <span className="connection-tree__type">{connection.config.type}</span>
    </button>
  );
}

export function ConnectionList() {
  const folders = useAppStore((s) => s.folders);
  const connections = useAppStore((s) => s.connections);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const addTab = useAppStore((s) => s.addTab);
  const setEditingConnection = useAppStore((s) => s.setEditingConnection);

  const handleConnect = useCallback(
    (connection: SavedConnection) => {
      addTab(connection.name, connection.config.type);
    },
    [addTab]
  );

  const handleEdit = useCallback(
    (connectionId: string) => {
      setEditingConnection(connectionId);
    },
    [setEditingConnection]
  );

  const handleNewConnection = useCallback(() => {
    setEditingConnection("new");
  }, [setEditingConnection]);

  const rootFolders = folders.filter((f) => f.parentId === null);
  const rootConnections = connections.filter((c) => c.folderId === null);

  return (
    <div className="connection-list">
      <div className="connection-list__header">
        <button
          className="connection-list__add-btn"
          onClick={handleNewConnection}
          title="New Connection"
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="connection-list__tree">
        {rootFolders.map((folder) => (
          <TreeNode
            key={folder.id}
            folder={folder}
            connections={connections.filter((c) => c.folderId === folder.id)}
            childFolders={folders.filter((f) => f.parentId === folder.id)}
            allFolders={folders}
            allConnections={connections}
            onToggle={toggleFolder}
            onConnect={handleConnect}
            onEdit={handleEdit}
            depth={0}
          />
        ))}
        {rootConnections.map((conn) => (
          <ConnectionItem
            key={conn.id}
            connection={conn}
            depth={0}
            onConnect={handleConnect}
            onEdit={handleEdit}
          />
        ))}
      </div>
    </div>
  );
}
