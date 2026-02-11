import { useCallback } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  Terminal,
  Wifi,
  Cable,
  Globe,
  Plus,
  Play,
  Pencil,
  Trash2,
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
  onDelete: (connectionId: string) => void;
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
  onDelete,
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
              onDelete={onDelete}
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
              onDelete={onDelete}
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
  onDelete: (connectionId: string) => void;
}

function ConnectionItem({ connection, depth, onConnect, onEdit, onDelete }: ConnectionItemProps) {
  const Icon = TYPE_ICONS[connection.config.type];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="connection-tree__item"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onDoubleClick={() => onConnect(connection)}
          title={`Double-click to connect: ${connection.name}`}
        >
          <Icon size={16} />
          <span className="connection-tree__label">{connection.name}</span>
          <span className="connection-tree__type">{connection.config.type}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="context-menu__content" sideOffset={4}>
          <DropdownMenu.Item
            className="context-menu__item"
            onSelect={() => onConnect(connection)}
          >
            <Play size={14} /> Connect
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="context-menu__item"
            onSelect={() => onEdit(connection.id)}
          >
            <Pencil size={14} /> Edit
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="context-menu__separator" />
          <DropdownMenu.Item
            className="context-menu__item context-menu__item--danger"
            onSelect={() => onDelete(connection.id)}
          >
            <Trash2 size={14} /> Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ConnectionList() {
  const folders = useAppStore((s) => s.folders);
  const connections = useAppStore((s) => s.connections);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const addTab = useAppStore((s) => s.addTab);
  const setEditingConnection = useAppStore((s) => s.setEditingConnection);
  const deleteConnection = useAppStore((s) => s.deleteConnection);

  const handleConnect = useCallback(
    (connection: SavedConnection) => {
      addTab(connection.name, connection.config.type, connection.config);
    },
    [addTab]
  );

  const handleEdit = useCallback(
    (connectionId: string) => {
      setEditingConnection(connectionId);
    },
    [setEditingConnection]
  );

  const handleDelete = useCallback(
    (connectionId: string) => {
      deleteConnection(connectionId);
    },
    [deleteConnection]
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
            onDelete={handleDelete}
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
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}
