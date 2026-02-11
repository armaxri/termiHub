import { useState, useCallback } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderPlus,
  Terminal,
  Wifi,
  Cable,
  Globe,
  Plus,
  Play,
  Pencil,
  Trash2,
  Download,
  Upload,
  Check,
  X,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { ConnectionType } from "@/types/terminal";
import { SavedConnection, ConnectionFolder } from "@/types/connection";
import { exportConnections, importConnections } from "@/services/storage";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import "./ConnectionList.css";

const TYPE_ICONS: Record<ConnectionType, typeof Terminal> = {
  local: Terminal,
  ssh: Wifi,
  serial: Cable,
  telnet: Globe,
};

interface InlineFolderInputProps {
  depth: number;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

function InlineFolderInput({ depth, onConfirm, onCancel }: InlineFolderInputProps) {
  const [name, setName] = useState("");

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && name.trim()) {
      onConfirm(name.trim());
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div
      className="connection-tree__folder connection-tree__folder--editing"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <Folder size={16} />
      <input
        className="connection-tree__inline-input"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        placeholder="Folder name"
        autoFocus
      />
      <button
        className="connection-tree__inline-btn"
        onMouseDown={(e) => {
          e.preventDefault();
          if (name.trim()) onConfirm(name.trim());
        }}
        title="Confirm"
      >
        <Check size={14} />
      </button>
      <button
        className="connection-tree__inline-btn"
        onMouseDown={(e) => {
          e.preventDefault();
          onCancel();
        }}
        title="Cancel"
      >
        <X size={14} />
      </button>
    </div>
  );
}

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
  onDeleteFolder: (folderId: string) => void;
  onCreateSubfolder: (parentId: string, name: string) => void;
  onNewConnectionInFolder: (folderId: string) => void;
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
  onDeleteFolder,
  onCreateSubfolder,
  onNewConnectionInFolder,
  depth,
}: TreeNodeProps) {
  const [creatingSubfolder, setCreatingSubfolder] = useState(false);
  const Chevron = folder.isExpanded ? ChevronDown : ChevronRight;

  return (
    <div className="connection-tree__node">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="connection-tree__folder"
            onClick={() => onToggle(folder.id)}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            <Chevron size={16} className="connection-tree__chevron" />
            <Folder size={16} />
            <span className="connection-tree__label">{folder.name}</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="context-menu__content" sideOffset={4}>
            <DropdownMenu.Item
              className="context-menu__item"
              onSelect={() => onNewConnectionInFolder(folder.id)}
            >
              <Plus size={14} /> New Connection
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="context-menu__item"
              onSelect={() => setCreatingSubfolder(true)}
            >
              <FolderPlus size={14} /> New Subfolder
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="context-menu__separator" />
            <DropdownMenu.Item
              className="context-menu__item context-menu__item--danger"
              onSelect={() => onDeleteFolder(folder.id)}
            >
              <Trash2 size={14} /> Delete Folder
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {folder.isExpanded && (
        <div className="connection-tree__children">
          {creatingSubfolder && (
            <InlineFolderInput
              depth={depth + 1}
              onConfirm={(name) => {
                onCreateSubfolder(folder.id, name);
                setCreatingSubfolder(false);
              }}
              onCancel={() => setCreatingSubfolder(false)}
            />
          )}
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
              onDeleteFolder={onDeleteFolder}
              onCreateSubfolder={onCreateSubfolder}
              onNewConnectionInFolder={onNewConnectionInFolder}
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
  const [creatingFolder, setCreatingFolder] = useState(false);
  const folders = useAppStore((s) => s.folders);
  const connections = useAppStore((s) => s.connections);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const addTab = useAppStore((s) => s.addTab);
  const setEditingConnection = useAppStore((s) => s.setEditingConnection);
  const deleteConnection = useAppStore((s) => s.deleteConnection);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const addFolder = useAppStore((s) => s.addFolder);
  const loadFromBackend = useAppStore((s) => s.loadFromBackend);

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

  const handleDeleteFolder = useCallback(
    (folderId: string) => {
      deleteFolder(folderId);
    },
    [deleteFolder]
  );

  const handleCreateFolder = useCallback(
    (parentId: string | null, name: string) => {
      addFolder({
        id: `folder-${Date.now()}`,
        name,
        parentId,
        isExpanded: true,
      });
    },
    [addFolder]
  );

  const handleNewConnection = useCallback(() => {
    setEditingConnection("new");
  }, [setEditingConnection]);

  const handleNewConnectionInFolder = useCallback(
    (folderId: string) => {
      setEditingConnection("new", folderId);
    },
    [setEditingConnection]
  );

  const handleExport = useCallback(async () => {
    try {
      const json = await exportConnections();
      const filePath = await save({
        defaultPath: "termihub-connections.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, json);
    } catch (err) {
      console.error("Failed to export connections:", err);
    }
  }, []);

  const handleImport = useCallback(async () => {
    try {
      const filePath = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      const json = await readTextFile(filePath);
      await importConnections(json);
      await loadFromBackend();
    } catch (err) {
      console.error("Failed to import connections:", err);
    }
  }, [loadFromBackend]);

  const rootFolders = folders.filter((f) => f.parentId === null);
  const rootConnections = connections.filter((c) => c.folderId === null);

  return (
    <div className="connection-list">
      <div className="connection-list__header">
        <button
          className="connection-list__add-btn"
          onClick={handleImport}
          title="Import Connections"
        >
          <Upload size={16} />
        </button>
        <button
          className="connection-list__add-btn"
          onClick={handleExport}
          title="Export Connections"
        >
          <Download size={16} />
        </button>
        <button
          className="connection-list__add-btn"
          onClick={() => setCreatingFolder(true)}
          title="New Folder"
        >
          <FolderPlus size={16} />
        </button>
        <button
          className="connection-list__add-btn"
          onClick={handleNewConnection}
          title="New Connection"
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="connection-list__tree">
        {creatingFolder && (
          <InlineFolderInput
            depth={0}
            onConfirm={(name) => {
              handleCreateFolder(null, name);
              setCreatingFolder(false);
            }}
            onCancel={() => setCreatingFolder(false)}
          />
        )}
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
            onDeleteFolder={handleDeleteFolder}
            onCreateSubfolder={handleCreateFolder}
            onNewConnectionInFolder={handleNewConnectionInFolder}
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
