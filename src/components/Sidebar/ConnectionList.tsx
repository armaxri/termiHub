import { useState, useCallback } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderPlus,
  FolderGit2,
  Terminal,
  Wifi,
  Cable,
  Globe,
  Server,
  Plus,
  Play,
  Pencil,
  Trash2,
  Copy,
  Check,
  X,
  Activity,
  AlertTriangle,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { ConnectionType, ShellType, SshConfig } from "@/types/terminal";
import { SavedConnection, ConnectionFolder, ExternalConnectionSource } from "@/types/connection";
import { listAvailableShells } from "@/services/api";
import "./ConnectionList.css";

const TYPE_ICONS: Record<ConnectionType, typeof Terminal> = {
  local: Terminal,
  ssh: Wifi,
  serial: Cable,
  telnet: Globe,
  remote: Server,
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
        data-testid="inline-folder-name-input"
      />
      <button
        className="connection-tree__inline-btn"
        onMouseDown={(e) => {
          e.preventDefault();
          if (name.trim()) onConfirm(name.trim());
        }}
        title="Confirm"
        data-testid="inline-folder-confirm"
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
        data-testid="inline-folder-cancel"
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
  onDuplicate: (connectionId: string) => void;
  onPingHost: (connection: SavedConnection) => void;
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
  onDuplicate,
  onPingHost,
  onDeleteFolder,
  onCreateSubfolder,
  onNewConnectionInFolder,
  depth,
}: TreeNodeProps) {
  const [creatingSubfolder, setCreatingSubfolder] = useState(false);
  const Chevron = folder.isExpanded ? ChevronDown : ChevronRight;

  const { setNodeRef, isOver } = useDroppable({
    id: folder.id,
    data: { type: "folder" },
  });

  return (
    <div className="connection-tree__node" ref={setNodeRef}>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            className={`connection-tree__folder${isOver ? " connection-tree__folder--drop-over" : ""}`}
            onClick={() => onToggle(folder.id)}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            data-testid={`folder-toggle-${folder.id}`}
          >
            <Chevron size={16} className="connection-tree__chevron" />
            <Folder size={16} />
            <span className="connection-tree__label">{folder.name}</span>
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="context-menu__content">
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onNewConnectionInFolder(folder.id)}
              data-testid="context-folder-new-connection"
            >
              <Plus size={14} /> New Connection
            </ContextMenu.Item>
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => setCreatingSubfolder(true)}
              data-testid="context-folder-new-subfolder"
            >
              <FolderPlus size={14} /> New Subfolder
            </ContextMenu.Item>
            <ContextMenu.Separator className="context-menu__separator" />
            <ContextMenu.Item
              className="context-menu__item context-menu__item--danger"
              onSelect={() => onDeleteFolder(folder.id)}
              data-testid="context-folder-delete"
            >
              <Trash2 size={14} /> Delete Folder
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
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
              onDuplicate={onDuplicate}
              onPingHost={onPingHost}
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
              onDuplicate={onDuplicate}
              onPingHost={onPingHost}
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
  onDuplicate: (connectionId: string) => void;
  onPingHost: (connection: SavedConnection) => void;
}

function ConnectionItem({
  connection,
  depth,
  onConnect,
  onEdit,
  onDelete,
  onDuplicate,
  onPingHost,
}: ConnectionItemProps) {
  const Icon = TYPE_ICONS[connection.config.type];

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: connection.id,
    data: { type: "connection", connection },
  });

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          ref={setDragRef}
          className={`connection-tree__item${isDragging ? " connection-tree__item--dragging" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onDoubleClick={() => onConnect(connection)}
          title={`Double-click to connect: ${connection.name}`}
          data-testid={`connection-item-${connection.id}`}
          {...attributes}
          {...listeners}
        >
          <Icon size={16} />
          <span className="connection-tree__label">{connection.name}</span>
          <span className="connection-tree__type">{connection.config.type}</span>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onConnect(connection)}
            data-testid="context-connection-connect"
          >
            <Play size={14} /> Connect
          </ContextMenu.Item>
          {(connection.config.type === "ssh" || connection.config.type === "telnet") && (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onPingHost(connection)}
              data-testid="context-connection-ping"
            >
              <Activity size={14} /> Ping Host
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onEdit(connection.id)}
            data-testid="context-connection-edit"
          >
            <Pencil size={14} /> Edit
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onDuplicate(connection.id)}
            data-testid="context-connection-duplicate"
          >
            <Copy size={14} /> Duplicate
          </ContextMenu.Item>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item context-menu__item--danger"
            onSelect={() => onDelete(connection.id)}
            data-testid="context-connection-delete"
          >
            <Trash2 size={14} /> Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function ConnectionList() {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [draggingConnection, setDraggingConnection] = useState<SavedConnection | null>(null);
  const folders = useAppStore((s) => s.folders);
  const connections = useAppStore((s) => s.connections);
  const externalSources = useAppStore((s) => s.externalSources);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const addTab = useAppStore((s) => s.addTab);
  const setEditingConnection = useAppStore((s) => s.setEditingConnection);
  const deleteConnection = useAppStore((s) => s.deleteConnection);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const addFolder = useAppStore((s) => s.addFolder);
  const duplicateConnection = useAppStore((s) => s.duplicateConnection);
  const moveConnectionToFolder = useAppStore((s) => s.moveConnectionToFolder);
  const deleteExternalConnection = useAppStore((s) => s.deleteExternalConnection);
  const duplicateExternalConnection = useAppStore((s) => s.duplicateExternalConnection);
  const addExternalFolder = useAppStore((s) => s.addExternalFolder);
  const deleteExternalFolder = useAppStore((s) => s.deleteExternalFolder);
  const moveConnectionToExternalFolder = useAppStore((s) => s.moveConnectionToExternalFolder);

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 8 },
  });
  const sensors = useSensors(pointerSensor);

  const requestPassword = useAppStore((s) => s.requestPassword);

  const handleConnect = useCallback(
    async (connection: SavedConnection) => {
      let config = connection.config;

      if (config.type === "ssh" && config.config.authMethod === "password") {
        const sshCfg = config.config as SshConfig;
        const password = await requestPassword(sshCfg.host, sshCfg.username);
        if (password === null) return;
        config = { ...config, config: { ...sshCfg, password } };
      }

      addTab(
        connection.name,
        connection.config.type,
        config,
        undefined,
        undefined,
        connection.terminalOptions
      );
    },
    [addTab, requestPassword]
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

  const handleDuplicate = useCallback(
    (connectionId: string) => {
      duplicateConnection(connectionId);
    },
    [duplicateConnection]
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

  const handlePingHost = useCallback(
    async (connection: SavedConnection) => {
      const config = connection.config;
      if (config.type !== "ssh" && config.type !== "telnet") return;
      const host = config.config.host;
      const shells = await listAvailableShells();
      if (shells.length === 0) return;
      addTab(`Ping ${host}`, "local", {
        type: "local",
        config: { shellType: shells[0] as ShellType, initialCommand: `ping ${host}` },
      });
    },
    [addTab]
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const conn = event.active.data.current?.connection as SavedConnection | undefined;
    setDraggingConnection(conn ?? null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingConnection(null);
      const { active, over } = event;
      if (!over) return;

      const connectionId = active.id as string;
      const overId = over.id as string;

      if (overId === "root") {
        moveConnectionToFolder(connectionId, null);
      } else if (over.data.current?.type === "folder") {
        moveConnectionToFolder(connectionId, overId);
      } else if (over.data.current?.type === "external-folder") {
        moveConnectionToExternalFolder(connectionId, overId);
      }
    },
    [moveConnectionToFolder, moveConnectionToExternalFolder]
  );

  const [localCollapsed, setLocalCollapsed] = useState(false);
  const rootFolders = folders.filter((f) => f.parentId === null);
  const rootConnections = connections.filter((c) => c.folderId === null);
  const LocalChevron = localCollapsed ? ChevronRight : ChevronDown;

  return (
    <div className="connection-list">
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="connection-list__group">
          <div className="connection-list__group-header">
            <button
              className="connection-list__group-toggle"
              onClick={() => setLocalCollapsed((v) => !v)}
              data-testid="connection-list-group-toggle"
            >
              <LocalChevron size={16} className="connection-tree__chevron" />
              <span className="connection-list__group-title">Connections</span>
            </button>
            <div className="connection-list__group-actions">
              <button
                className="connection-list__add-btn"
                onClick={() => {
                  setLocalCollapsed(false);
                  setCreatingFolder(true);
                }}
                title="New Folder"
                data-testid="connection-list-new-folder"
              >
                <FolderPlus size={16} />
              </button>
              <button
                className="connection-list__add-btn"
                onClick={handleNewConnection}
                title="New Connection"
                data-testid="connection-list-new-connection"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
          {!localCollapsed && (
            <RootDropZone
              isCreatingFolder={creatingFolder}
              onCreateFolder={(name) => {
                handleCreateFolder(null, name);
                setCreatingFolder(false);
              }}
              onCancelCreateFolder={() => setCreatingFolder(false)}
              rootFolders={rootFolders}
              rootConnections={rootConnections}
              folders={folders}
              connections={connections}
              onToggle={toggleFolder}
              onConnect={handleConnect}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onDuplicate={handleDuplicate}
              onPingHost={handlePingHost}
              onDeleteFolder={handleDeleteFolder}
              onCreateSubfolder={handleCreateFolder}
              onNewConnectionInFolder={handleNewConnectionInFolder}
            />
          )}
        </div>
        {externalSources.map((source) => (
          <ExternalSourceSection
            key={source.filePath}
            source={source}
            onConnect={handleConnect}
            onEdit={handleEdit}
            onDelete={(connId) => deleteExternalConnection(source.filePath, connId)}
            onDuplicate={(connId) => duplicateExternalConnection(source.filePath, connId)}
            onPingHost={handlePingHost}
            onDeleteFolder={(folderId) => deleteExternalFolder(source.filePath, folderId)}
            onCreateSubfolder={(parentId, name) => {
              const prefix = `ext:${source.filePath}::`;
              addExternalFolder(source.filePath, {
                id: `${prefix}folder-${Date.now()}`,
                name,
                parentId,
                isExpanded: true,
              });
            }}
            onNewConnectionInFolder={(folderId) => {
              setEditingConnection("new", folderId);
            }}
          />
        ))}
        <DragOverlay>
          {draggingConnection ? (
            <div className="connection-tree__drag-overlay">
              {(() => {
                const DragIcon = TYPE_ICONS[draggingConnection.config.type];
                return <DragIcon size={16} />;
              })()}
              <span>{draggingConnection.name}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

interface RootDropZoneProps {
  isCreatingFolder: boolean;
  onCreateFolder: (name: string) => void;
  onCancelCreateFolder: () => void;
  rootFolders: ConnectionFolder[];
  rootConnections: SavedConnection[];
  folders: ConnectionFolder[];
  connections: SavedConnection[];
  onToggle: (folderId: string) => void;
  onConnect: (connection: SavedConnection) => void;
  onEdit: (connectionId: string) => void;
  onDelete: (connectionId: string) => void;
  onDuplicate: (connectionId: string) => void;
  onPingHost: (connection: SavedConnection) => void;
  onDeleteFolder: (folderId: string) => void;
  onCreateSubfolder: (parentId: string, name: string) => void;
  onNewConnectionInFolder: (folderId: string) => void;
}

function RootDropZone({
  isCreatingFolder,
  onCreateFolder,
  onCancelCreateFolder,
  rootFolders,
  rootConnections,
  folders,
  connections,
  onToggle,
  onConnect,
  onEdit,
  onDelete,
  onDuplicate,
  onPingHost,
  onDeleteFolder,
  onCreateSubfolder,
  onNewConnectionInFolder,
}: RootDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: "root",
    data: { type: "root" },
  });

  return (
    <div
      ref={setNodeRef}
      className={`connection-list__tree${isOver ? " connection-tree__root-drop--over" : ""}`}
    >
      {isCreatingFolder && (
        <InlineFolderInput depth={0} onConfirm={onCreateFolder} onCancel={onCancelCreateFolder} />
      )}
      {rootFolders.map((folder) => (
        <TreeNode
          key={folder.id}
          folder={folder}
          connections={connections.filter((c) => c.folderId === folder.id)}
          childFolders={folders.filter((f) => f.parentId === folder.id)}
          allFolders={folders}
          allConnections={connections}
          onToggle={onToggle}
          onConnect={onConnect}
          onEdit={onEdit}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onPingHost={onPingHost}
          onDeleteFolder={onDeleteFolder}
          onCreateSubfolder={onCreateSubfolder}
          onNewConnectionInFolder={onNewConnectionInFolder}
          depth={0}
        />
      ))}
      {rootConnections.map((conn) => (
        <ConnectionItem
          key={conn.id}
          connection={conn}
          depth={0}
          onConnect={onConnect}
          onEdit={onEdit}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onPingHost={onPingHost}
        />
      ))}
    </div>
  );
}

// --- External source components ---

interface ExternalSourceSectionProps {
  source: ExternalConnectionSource;
  onConnect: (connection: SavedConnection) => void;
  onEdit: (connectionId: string) => void;
  onDelete: (connectionId: string) => void;
  onDuplicate: (connectionId: string) => void;
  onPingHost: (connection: SavedConnection) => void;
  onDeleteFolder: (folderId: string) => void;
  onCreateSubfolder: (parentId: string, name: string) => void;
  onNewConnectionInFolder: (folderId: string) => void;
}

function ExternalSourceSection({
  source,
  onConnect,
  onEdit,
  onDelete,
  onDuplicate,
  onPingHost,
  onDeleteFolder,
  onCreateSubfolder,
  onNewConnectionInFolder,
}: ExternalSourceSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const folder of source.folders) {
      initial[folder.id] = folder.isExpanded;
    }
    return initial;
  });

  const toggleExtFolder = useCallback((folderId: string) => {
    setExpandedFolders((prev) => ({ ...prev, [folderId]: !prev[folderId] }));
  }, []);

  const rootId = `ext-root:${source.filePath}`;
  // Subfolders directly under root
  const childFolders = source.folders.filter((f) => f.parentId === rootId);
  // Connections directly under root
  const rootConnections = source.connections.filter((c) => c.folderId === rootId);
  const SectionChevron = collapsed ? ChevronRight : ChevronDown;

  const handleNewConnection = useCallback(() => {
    setCollapsed(false);
    onNewConnectionInFolder(rootId);
  }, [onNewConnectionInFolder, rootId]);

  const handleNewFolder = useCallback(() => {
    setCollapsed(false);
    setCreatingFolder(true);
  }, []);

  return (
    <div className="connection-list__group connection-list__group--external">
      <div className="connection-list__group-header">
        <button
          className="connection-list__group-toggle"
          onClick={() => setCollapsed((v) => !v)}
          data-testid={`external-source-toggle-${source.filePath}`}
        >
          <SectionChevron size={16} className="connection-tree__chevron" />
          <FolderGit2 size={16} />
          <span className="connection-list__group-title">{source.name}</span>
          {source.error && (
            <span className="connection-tree__source-error" title={source.error}>
              <AlertTriangle size={14} />
            </span>
          )}
        </button>
        <div className="connection-list__group-actions">
          <button
            className="connection-list__add-btn"
            onClick={handleNewFolder}
            title="New Folder"
            data-testid="external-source-new-folder"
          >
            <FolderPlus size={16} />
          </button>
          <button
            className="connection-list__add-btn"
            onClick={handleNewConnection}
            title="New Connection"
            data-testid="external-source-new-connection"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="connection-list__tree">
          {creatingFolder && (
            <InlineFolderInput
              depth={0}
              onConfirm={(name) => {
                onCreateSubfolder(rootId, name);
                setCreatingFolder(false);
              }}
              onCancel={() => setCreatingFolder(false)}
            />
          )}
          {childFolders.map((child) => (
            <ExternalTreeNode
              key={child.id}
              folder={child}
              connections={source.connections.filter((c) => c.folderId === child.id)}
              childFolders={source.folders.filter((f) => f.parentId === child.id)}
              allFolders={source.folders}
              allConnections={source.connections}
              expandedFolders={expandedFolders}
              onToggle={toggleExtFolder}
              onConnect={onConnect}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onPingHost={onPingHost}
              onDeleteFolder={onDeleteFolder}
              onCreateSubfolder={onCreateSubfolder}
              onNewConnectionInFolder={onNewConnectionInFolder}
              depth={0}
            />
          ))}
          {rootConnections.map((conn) => (
            <ExternalConnectionItem
              key={conn.id}
              connection={conn}
              depth={0}
              onConnect={onConnect}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onPingHost={onPingHost}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ExternalTreeNodeProps {
  folder: ConnectionFolder;
  connections: SavedConnection[];
  childFolders: ConnectionFolder[];
  allFolders: ConnectionFolder[];
  allConnections: SavedConnection[];
  expandedFolders: Record<string, boolean>;
  onToggle: (folderId: string) => void;
  onConnect: (connection: SavedConnection) => void;
  onEdit: (connectionId: string) => void;
  onDelete: (connectionId: string) => void;
  onDuplicate: (connectionId: string) => void;
  onPingHost: (connection: SavedConnection) => void;
  onDeleteFolder: (folderId: string) => void;
  onCreateSubfolder: (parentId: string, name: string) => void;
  onNewConnectionInFolder: (folderId: string) => void;
  depth: number;
}

function ExternalTreeNode({
  folder,
  connections,
  childFolders,
  allFolders,
  allConnections,
  expandedFolders,
  onToggle,
  onConnect,
  onEdit,
  onDelete,
  onDuplicate,
  onPingHost,
  onDeleteFolder,
  onCreateSubfolder,
  onNewConnectionInFolder,
  depth,
}: ExternalTreeNodeProps) {
  const [creatingSubfolder, setCreatingSubfolder] = useState(false);
  const isExpanded = expandedFolders[folder.id] ?? folder.isExpanded;
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  const { setNodeRef, isOver } = useDroppable({
    id: folder.id,
    data: { type: "external-folder" },
  });

  return (
    <div className="connection-tree__node" ref={setNodeRef}>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            className={`connection-tree__folder connection-tree__folder--external${isOver ? " connection-tree__folder--drop-over" : ""}`}
            onClick={() => onToggle(folder.id)}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            data-testid={`external-folder-toggle-${folder.id}`}
          >
            <Chevron size={16} className="connection-tree__chevron" />
            <Folder size={16} />
            <span className="connection-tree__label">{folder.name}</span>
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="context-menu__content">
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onNewConnectionInFolder(folder.id)}
              data-testid="context-external-folder-new-connection"
            >
              <Plus size={14} /> New Connection
            </ContextMenu.Item>
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => setCreatingSubfolder(true)}
              data-testid="context-external-folder-new-subfolder"
            >
              <FolderPlus size={14} /> New Subfolder
            </ContextMenu.Item>
            <ContextMenu.Separator className="context-menu__separator" />
            <ContextMenu.Item
              className="context-menu__item context-menu__item--danger"
              onSelect={() => onDeleteFolder(folder.id)}
              data-testid="context-external-folder-delete"
            >
              <Trash2 size={14} /> Delete Folder
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {isExpanded && (
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
            <ExternalTreeNode
              key={child.id}
              folder={child}
              connections={allConnections.filter((c) => c.folderId === child.id)}
              childFolders={allFolders.filter((f) => f.parentId === child.id)}
              allFolders={allFolders}
              allConnections={allConnections}
              expandedFolders={expandedFolders}
              onToggle={onToggle}
              onConnect={onConnect}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onPingHost={onPingHost}
              onDeleteFolder={onDeleteFolder}
              onCreateSubfolder={onCreateSubfolder}
              onNewConnectionInFolder={onNewConnectionInFolder}
              depth={depth + 1}
            />
          ))}
          {connections.map((conn) => (
            <ExternalConnectionItem
              key={conn.id}
              connection={conn}
              depth={depth + 1}
              onConnect={onConnect}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onPingHost={onPingHost}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ExternalConnectionItemProps {
  connection: SavedConnection;
  depth: number;
  onConnect: (connection: SavedConnection) => void;
  onEdit: (connectionId: string) => void;
  onDelete: (connectionId: string) => void;
  onDuplicate: (connectionId: string) => void;
  onPingHost: (connection: SavedConnection) => void;
}

function ExternalConnectionItem({
  connection,
  depth,
  onConnect,
  onEdit,
  onDelete,
  onDuplicate,
  onPingHost,
}: ExternalConnectionItemProps) {
  const Icon = TYPE_ICONS[connection.config.type];

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: connection.id,
    data: { type: "connection", connection },
  });

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          ref={setDragRef}
          className={`connection-tree__item connection-tree__item--external${isDragging ? " connection-tree__item--dragging" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onDoubleClick={() => onConnect(connection)}
          title={`Double-click to connect: ${connection.name}`}
          data-testid={`external-connection-item-${connection.id}`}
          {...attributes}
          {...listeners}
        >
          <Icon size={16} />
          <span className="connection-tree__label">{connection.name}</span>
          <span className="connection-tree__type">{connection.config.type}</span>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onConnect(connection)}
            data-testid="context-external-connection-connect"
          >
            <Play size={14} /> Connect
          </ContextMenu.Item>
          {(connection.config.type === "ssh" || connection.config.type === "telnet") && (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onPingHost(connection)}
              data-testid="context-external-connection-ping"
            >
              <Activity size={14} /> Ping Host
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onEdit(connection.id)}
            data-testid="context-external-connection-edit"
          >
            <Pencil size={14} /> Edit
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onDuplicate(connection.id)}
            data-testid="context-external-connection-duplicate"
          >
            <Copy size={14} /> Duplicate
          </ContextMenu.Item>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item context-menu__item--danger"
            onSelect={() => onDelete(connection.id)}
            data-testid="context-external-connection-delete"
          >
            <Trash2 size={14} /> Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
