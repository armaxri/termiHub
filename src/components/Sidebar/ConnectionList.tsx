import { useState, useCallback, Fragment, useMemo } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDndContext,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderPlus,
  Plus,
  Play,
  Pencil,
  Trash2,
  Copy,
  Activity,
  Server,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { ShellType } from "@/types/terminal";
import { SavedConnection, ConnectionFolder } from "@/types/connection";
import {
  listAvailableShells,
  createTerminal,
  removeCredential,
  storeCredential,
  type AgentDefinitionInfo,
} from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import { useSectionResize } from "@/hooks/useSectionResize";
import { useTreeSelection } from "@/hooks/useTreeSelection";
import { computeFlatVisibleIds } from "@/utils/computeFlatVisibleIds";
import { AgentNode } from "./AgentNode";
import { InlineFolderInput } from "./InlineFolderInput";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import "./ConnectionList.css";

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
  selectedConnectionIds: Set<string>;
  onConnectionClick: (connectionId: string, event: React.MouseEvent) => void;
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
  selectedConnectionIds,
  onConnectionClick,
  depth,
}: TreeNodeProps) {
  const [creatingSubfolder, setCreatingSubfolder] = useState(false);
  const Chevron = folder.isExpanded ? ChevronDown : ChevronRight;

  const { setNodeRef, isOver } = useDroppable({
    id: folder.id,
    data: { type: "folder" },
  });
  const { active } = useDndContext();
  const isConnectionOver =
    isOver &&
    active?.data.current?.type !== "agent" &&
    active?.data.current?.type !== "agent-connection";

  return (
    <div className="connection-tree__node">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            ref={setNodeRef}
            className={`connection-tree__folder${isConnectionOver ? " connection-tree__folder--drop-over" : ""}`}
            onClick={() => onToggle(folder.id)}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            data-testid={`folder-toggle-${folder.id}`}
          >
            <Folder size={16} />
            <span className="connection-tree__label">{folder.name}</span>
            <Chevron size={16} className="connection-tree__chevron" />
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
              selectedConnectionIds={selectedConnectionIds}
              onConnectionClick={onConnectionClick}
              depth={depth + 1}
            />
          ))}
          {connections.map((conn) => (
            <ConnectionItem
              key={conn.id}
              connection={conn}
              depth={depth + 1}
              isSelected={selectedConnectionIds.has(conn.id)}
              onConnect={onConnect}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onPingHost={onPingHost}
              onConnectionClick={onConnectionClick}
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
  isSelected: boolean;
  onConnect: (connection: SavedConnection) => void;
  onEdit: (connectionId: string) => void;
  onDelete: (connectionId: string) => void;
  onDuplicate: (connectionId: string) => void;
  onPingHost: (connection: SavedConnection) => void;
  onConnectionClick: (connectionId: string, event: React.MouseEvent) => void;
}

function ConnectionItem({
  connection,
  depth,
  isSelected,
  onConnect,
  onEdit,
  onDelete,
  onDuplicate,
  onPingHost,
  onConnectionClick,
}: ConnectionItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: connection.id,
    data: { type: "connection", connection },
  });

  let className = "connection-tree__item";
  if (isDragging) className += " connection-tree__item--dragging";
  if (isSelected) className += " connection-tree__item--selected";

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          ref={setDragRef}
          className={className}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={(e) => onConnectionClick(connection.id, e)}
          onDoubleClick={() => onConnect(connection)}
          title={`Double-click to connect: ${connection.name}`}
          data-testid={`connection-item-${connection.id}`}
          {...attributes}
          {...listeners}
        >
          <ConnectionIcon config={connection.config} customIcon={connection.icon} size={16} />
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
          {!!(connection.config.config as unknown as Record<string, unknown>).host && (
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

function buildExpandedIndexMap(sectionsExpanded: boolean[]): { map: number[]; count: number } {
  const map: number[] = [];
  let count = 0;
  for (const isExpanded of sectionsExpanded) {
    map.push(isExpanded ? count++ : -1);
  }
  return { map, count };
}

export function ConnectionList() {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [draggingConnection, setDraggingConnection] = useState<SavedConnection | null>(null);
  const [draggingAgentName, setDraggingAgentName] = useState<string | null>(null);
  const [draggingAgentDef, setDraggingAgentDef] = useState<AgentDefinitionInfo | null>(null);
  const [draggingSelectionCount, setDraggingSelectionCount] = useState(0);
  const folders = useAppStore((s) => s.folders);
  const connections = useAppStore((s) => s.connections);
  const remoteAgents = useAppStore((s) => s.remoteAgents);
  const experimental = useExperimentalFeatures();
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const addTab = useAppStore((s) => s.addTab);
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const deleteConnection = useAppStore((s) => s.deleteConnection);
  const bulkDeleteConnections = useAppStore((s) => s.bulkDeleteConnections);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const addFolder = useAppStore((s) => s.addFolder);
  const duplicateConnection = useAppStore((s) => s.duplicateConnection);
  const moveConnectionToFolder = useAppStore((s) => s.moveConnectionToFolder);
  const bulkMoveConnectionsToFolder = useAppStore((s) => s.bulkMoveConnectionsToFolder);
  const reorderRemoteAgents = useAppStore((s) => s.reorderRemoteAgents);
  const moveAgentDefToFolder = useAppStore((s) => s.moveAgentDefToFolder);
  const bulkMoveAgentDefsToFolder = useAppStore((s) => s.bulkMoveAgentDefsToFolder);
  const agentDefinitions = useAppStore((s) => s.agentDefinitions);

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 8 },
  });
  const sensors = useSensors(pointerSensor);

  const requestPassword = useAppStore((s) => s.requestPassword);

  const rootFolders = useMemo(() => folders.filter((f) => f.parentId === null), [folders]);
  const rootConnections = useMemo(
    () => connections.filter((c) => c.folderId === null),
    [connections]
  );

  const flatVisibleConnectionIds = useMemo(
    () => computeFlatVisibleIds(rootFolders, rootConnections, folders, connections),
    [rootFolders, rootConnections, folders, connections]
  );

  const {
    selectedIds: selectedConnectionIds,
    handleItemClick: handleConnectionClick,
    handleAreaClick: handleTreeAreaClick,
    clearSelection: clearConnectionSelection,
    selectSingle: selectConnectionSingle,
  } = useTreeSelection(flatVisibleConnectionIds);

  const handleConnect = useCallback(
    async (connection: SavedConnection) => {
      let config = connection.config;
      const cfg = config.config as unknown as Record<string, unknown>;

      // Connections with authMethod and password support credential store resolution
      if (cfg.authMethod && cfg.host) {
        const authMethod = cfg.authMethod as string;
        const savePassword = cfg.savePassword as boolean | undefined;

        // Before attempting credential resolution, check whether the credential store
        // is locked. If it is, we can't read the stored credential and SSH would fall
        // back to interactive password prompts. Prompt for unlock first and wait —
        // on success the code continues and the credential resolves automatically.
        const needsStoredCredential =
          authMethod === "password" || (authMethod === "key" && savePassword);
        if (needsStoredCredential) {
          const credStatus = useAppStore.getState().credentialStoreStatus;
          if (credStatus?.mode === "master_password" && credStatus?.status === "locked") {
            const unlocked = await useAppStore.getState().requestUnlock();
            if (!unlocked) return;
          }
        }

        // Try to resolve credential from the store first
        const resolution = await resolveConnectionCredential(
          connection.id,
          authMethod,
          savePassword
        );

        if (resolution.usedStoredCredential && resolution.password) {
          // Pre-connect with stored credential to validate it
          const preConfig = {
            ...config,
            config: { ...cfg, password: resolution.password },
          } as typeof config;
          try {
            const sessionId = await createTerminal(preConfig);
            // Stored credential worked — open tab with existing session
            addTab(
              connection.name,
              connection.config.type,
              preConfig,
              undefined,
              undefined,
              connection.terminalOptions,
              sessionId
            );
            return;
          } catch (err) {
            const errStr = String(err);
            if (
              errStr.toLowerCase().includes("auth failed") ||
              errStr.includes("Authentication failed")
            ) {
              // Stale credential — remove it and fall through to prompt
              await removeCredential(connection.id, resolution.credentialType).catch(() => {});
            } else {
              // Non-auth failure — let the Terminal component handle the error
              addTab(
                connection.name,
                connection.config.type,
                config,
                undefined,
                undefined,
                connection.terminalOptions
              );
              return;
            }
          }
        }

        // No stored credential or stale credential was cleared — prompt the user
        if (authMethod === "password") {
          const host = cfg.host as string;
          const username = (cfg.username as string) ?? "";
          const password = await requestPassword(host, username);
          if (password === null) return;
          config = { ...config, config: { ...cfg, password } } as typeof config;
          // Persist the entered password if the user opted in via the prompt checkbox
          if (useAppStore.getState().passwordPromptShouldSave) {
            await storeCredential(connection.id, "password", password).catch((err) => {
              frontendLog("connection_list", `Failed to store credential: ${err}`);
            });
          }
        } else if (authMethod === "key" && savePassword) {
          // Key auth with passphrase storage opted in but no passphrase stored yet —
          // prompt for the passphrase so the backend can unlock the key.
          const host = cfg.host as string;
          const username = (cfg.username as string) ?? "";
          const passphrase = await requestPassword(host, username);
          if (passphrase === null) return;
          config = { ...config, config: { ...cfg, password: passphrase } } as typeof config;
          if (useAppStore.getState().passwordPromptShouldSave) {
            await storeCredential(connection.id, "key_passphrase", passphrase).catch((err) => {
              frontendLog("connection_list", `Failed to store key passphrase: ${err}`);
            });
          }
        }
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
      openConnectionEditorTab(connectionId);
    },
    [openConnectionEditorTab]
  );

  const handleDelete = useCallback(
    (connectionId: string) => {
      if (selectedConnectionIds.size > 1 && selectedConnectionIds.has(connectionId)) {
        bulkDeleteConnections([...selectedConnectionIds]);
        clearConnectionSelection();
      } else {
        deleteConnection(connectionId);
      }
    },
    [deleteConnection, bulkDeleteConnections, selectedConnectionIds, clearConnectionSelection]
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
    openConnectionEditorTab("new");
  }, [openConnectionEditorTab]);

  const handleNewConnectionInFolder = useCallback(
    (folderId: string) => {
      openConnectionEditorTab("new", folderId);
    },
    [openConnectionEditorTab]
  );

  const handleNewAgent = useCallback(() => {
    openConnectionEditorTab("new-remote-agent");
  }, [openConnectionEditorTab]);

  const handlePingHost = useCallback(
    async (connection: SavedConnection) => {
      const cfg = connection.config.config as unknown as Record<string, unknown>;
      const host = cfg.host as string | undefined;
      if (!host) return;
      const shells = await listAvailableShells();
      if (shells.length === 0) return;
      addTab(`Ping ${host}`, "local", {
        type: "local",
        config: { shell: shells[0] as ShellType, initialCommand: `ping ${host}` },
      });
    },
    [addTab]
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current;
      if (data?.type === "agent") {
        setDraggingConnection(null);
        setDraggingAgentDef(null);
        setDraggingSelectionCount(0);
        const agent = remoteAgents.find((a) => a.id === event.active.id);
        setDraggingAgentName(agent?.name ?? null);
      } else if (data?.type === "agent-connection") {
        setDraggingConnection(null);
        setDraggingAgentName(null);
        const selectionCount = (data.selectionCount as number) ?? 1;
        if (selectionCount > 1) {
          setDraggingAgentDef(null);
          setDraggingSelectionCount(selectionCount);
        } else {
          setDraggingAgentDef(data.definition as AgentDefinitionInfo);
          setDraggingSelectionCount(1);
        }
      } else {
        setDraggingAgentName(null);
        setDraggingAgentDef(null);
        const conn = data?.connection as SavedConnection | undefined;
        if (!conn) return;

        // If dragging a selected item, drag the whole selection
        if (selectedConnectionIds.has(conn.id) && selectedConnectionIds.size > 1) {
          setDraggingConnection(null);
          setDraggingSelectionCount(selectedConnectionIds.size);
        } else {
          // Not part of current selection — switch to single-item drag
          selectConnectionSingle(conn.id);
          setDraggingConnection(conn);
          setDraggingSelectionCount(1);
        }
      }
    },
    [remoteAgents, selectedConnectionIds, selectConnectionSingle]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingConnection(null);
      setDraggingAgentName(null);
      setDraggingAgentDef(null);
      setDraggingSelectionCount(0);
      const { active, over } = event;
      if (!over) return;

      // Handle agent-connection drag to an agent folder or agent root
      if (active.data.current?.type === "agent-connection") {
        const definition = active.data.current.definition as AgentDefinitionInfo;
        const defAgentId = active.data.current.agentId as string;
        const draggedSelectedIds = (active.data.current.selectedDefIds as string[]) ?? [
          definition.id,
        ];
        const overId = over.id as string;

        let targetFolderId: string | null | undefined;

        if (overId === `agent-root:${defAgentId}`) {
          targetFolderId = null;
        } else if (
          over.data.current?.type === "agent-folder" &&
          (over.data.current?.agentId as string) === defAgentId
        ) {
          targetFolderId = over.data.current.folderId as string;
        }

        if (targetFolderId === undefined) return;

        const agentDefs = agentDefinitions[defAgentId] ?? [];
        const idsToMove = draggedSelectedIds.filter((id) => {
          const def = agentDefs.find((d) => d.id === id);
          return def?.folderId !== targetFolderId;
        });

        if (idsToMove.length === 1) {
          moveAgentDefToFolder(defAgentId, idsToMove[0], targetFolderId);
        } else if (idsToMove.length > 1) {
          bulkMoveAgentDefsToFolder(defAgentId, idsToMove, targetFolderId);
        }
        return;
      }

      // Handle agent reorder
      if (active.data.current?.type === "agent" && over.data.current?.type === "agent") {
        const activeId = active.id as string;
        const overId = over.id as string;
        if (activeId !== overId) {
          const oldIndex = remoteAgents.findIndex((a) => a.id === activeId);
          const newIndex = remoteAgents.findIndex((a) => a.id === overId);
          if (oldIndex !== -1 && newIndex !== -1) {
            reorderRemoteAgents(oldIndex, newIndex);
          }
        }
        return;
      }

      // Handle connection drag to folder/root
      const draggedConnection = active.data.current?.connection as SavedConnection | undefined;
      if (!draggedConnection) return;

      const overId = over.id as string;
      let targetFolderId: string | null | undefined;

      if (overId === "root") {
        targetFolderId = null;
      } else if (over.data.current?.type === "folder") {
        targetFolderId = overId;
      }

      if (targetFolderId === undefined) return;

      // Move all selected connections, or just the dragged one if it's a single-item drag
      const idsToMove =
        selectedConnectionIds.has(draggedConnection.id) && selectedConnectionIds.size > 1
          ? [...selectedConnectionIds]
          : [draggedConnection.id];

      // Skip connections already in the target folder
      const idsToActuallyMove = idsToMove.filter((id) => {
        const conn = connections.find((c) => c.id === id);
        return conn?.folderId !== targetFolderId;
      });

      if (idsToActuallyMove.length === 1) {
        moveConnectionToFolder(idsToActuallyMove[0], targetFolderId);
      } else if (idsToActuallyMove.length > 1) {
        bulkMoveConnectionsToFolder(idsToActuallyMove, targetFolderId);
      }

      clearConnectionSelection();
    },
    [
      moveConnectionToFolder,
      bulkMoveConnectionsToFolder,
      moveAgentDefToFolder,
      bulkMoveAgentDefsToFolder,
      agentDefinitions,
      remoteAgents,
      reorderRemoteAgents,
      selectedConnectionIds,
      connections,
      clearConnectionSelection,
    ]
  );

  const [localCollapsed, setLocalCollapsed] = useState(false);
  const [remoteAgentsCollapsed, setRemoteAgentsCollapsed] = useState(false);
  const LocalChevron = localCollapsed ? ChevronRight : ChevronDown;
  const RemoteAgentsChevron = remoteAgentsCollapsed ? ChevronRight : ChevronDown;

  const outerSectionsExpanded = useMemo(
    () => [!localCollapsed, experimental] as boolean[],
    [localCollapsed, experimental]
  );
  const { map: outerExpandedIndexMap, count: outerExpandedCount } = useMemo(
    () => buildExpandedIndexMap(outerSectionsExpanded),
    [outerSectionsExpanded]
  );
  const {
    flexValues: outerFlexValues,
    handleProps: outerHandleProps,
    sectionRefs: outerSectionRefs,
  } = useSectionResize(outerExpandedCount);
  const outerConnIdx = outerExpandedIndexMap[0];
  const outerRemoteIdx = outerExpandedIndexMap[1];
  const outerResizeProps =
    outerConnIdx >= 0 && outerRemoteIdx >= 0 && outerRemoteIdx === outerConnIdx + 1
      ? outerHandleProps(outerConnIdx)
      : {};
  const isOuterResizable = "onMouseDown" in outerResizeProps;

  const innerSectionsExpanded = useMemo(
    () => (remoteAgentsCollapsed ? [] : remoteAgents.map((a) => a.isExpanded)),
    [remoteAgentsCollapsed, remoteAgents]
  );
  const { map: innerExpandedIndexMap, count: innerExpandedCount } = useMemo(
    () => buildExpandedIndexMap(innerSectionsExpanded),
    [innerSectionsExpanded]
  );
  const {
    flexValues: innerFlexValues,
    handleProps: innerHandleProps,
    sectionRefs: innerSectionRefs,
  } = useSectionResize(innerExpandedCount);

  const getInnerResizeHandleProps = useCallback(
    (agentIndex: number) => {
      const eiAbove = innerExpandedIndexMap[agentIndex - 1];
      const eiBelow = innerExpandedIndexMap[agentIndex];
      if (eiAbove >= 0 && eiBelow >= 0 && eiBelow === eiAbove + 1) {
        return innerHandleProps(eiAbove);
      }
      return {};
    },
    [innerExpandedIndexMap, innerHandleProps]
  );

  return (
    <div className="connection-list">
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div
          ref={(el) => {
            if (outerConnIdx >= 0) outerSectionRefs.current[outerConnIdx] = el;
          }}
          className={`connection-list__group${!localCollapsed ? " connection-list__group--expanded" : ""}`}
          style={outerConnIdx >= 0 ? { flex: outerFlexValues[outerConnIdx] } : undefined}
        >
          <div
            className="connection-list__group-header"
            data-testid="sidebar-group-header-connections"
          >
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
              onNewConnection={handleNewConnection}
              onNewFolder={() => setCreatingFolder(true)}
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
              selectedConnectionIds={selectedConnectionIds}
              onConnectionClick={handleConnectionClick}
              onTreeAreaClick={handleTreeAreaClick}
            />
          )}
        </div>
        {experimental && (
          <>
            <div
              className={`connection-list__resize-handle${isOuterResizable ? " connection-list__resize-handle--resizable" : ""}`}
              data-testid="sidebar-outer-separator"
              {...outerResizeProps}
            />
            <div
              ref={(el) => {
                if (outerRemoteIdx >= 0) outerSectionRefs.current[outerRemoteIdx] = el;
              }}
              className="connection-list__remote-agents"
              style={outerRemoteIdx >= 0 ? { flex: outerFlexValues[outerRemoteIdx] } : undefined}
            >
              <div
                className="connection-list__group-header"
                data-testid="sidebar-group-header-remote-agents"
              >
                <button
                  className="connection-list__group-toggle"
                  onClick={() => setRemoteAgentsCollapsed((v) => !v)}
                  data-testid="connection-list-remote-agents-toggle"
                >
                  <RemoteAgentsChevron size={16} className="connection-tree__chevron" />
                  <span className="connection-list__group-title">Remote Agents</span>
                </button>
                <div className="connection-list__group-actions">
                  <button
                    className="connection-list__add-btn"
                    onClick={handleNewAgent}
                    title="New Remote Agent"
                    data-testid="connection-list-new-agent"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
              {!remoteAgentsCollapsed && (
                <SortableContext
                  items={remoteAgents.map((a) => a.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {remoteAgents.map((agent, i) => {
                    const innerIdx = innerExpandedIndexMap[i];
                    const innerResizeProps = i > 0 ? getInnerResizeHandleProps(i) : {};
                    const isInnerResizable = "onMouseDown" in innerResizeProps;
                    return (
                      <Fragment key={agent.id}>
                        {i > 0 && (
                          <div
                            className={`connection-list__resize-handle${isInnerResizable ? " connection-list__resize-handle--resizable" : ""}`}
                            data-testid={`sidebar-group-separator-${i - 1}`}
                            {...innerResizeProps}
                          />
                        )}
                        <AgentNode
                          agent={agent}
                          style={innerIdx >= 0 ? { flex: innerFlexValues[innerIdx] } : undefined}
                          sectionRef={(el) => {
                            if (innerIdx >= 0) innerSectionRefs.current[innerIdx] = el;
                          }}
                        />
                      </Fragment>
                    );
                  })}
                </SortableContext>
              )}
            </div>
          </>
        )}
        <DragOverlay>
          {draggingSelectionCount > 1 ? (
            <div className="connection-tree__drag-overlay">
              <span>{draggingSelectionCount} connections</span>
            </div>
          ) : draggingConnection ? (
            <div className="connection-tree__drag-overlay">
              <ConnectionIcon
                config={draggingConnection.config}
                customIcon={draggingConnection.icon}
                size={16}
              />
              <span>{draggingConnection.name}</span>
            </div>
          ) : draggingAgentDef ? (
            <div className="connection-tree__drag-overlay">
              <ConnectionIcon
                config={{
                  type: "remote-session",
                  config: { sessionType: draggingAgentDef.sessionType },
                }}
                customIcon={draggingAgentDef.icon}
                size={16}
              />
              <span>{draggingAgentDef.name}</span>
            </div>
          ) : draggingAgentName ? (
            <div className="connection-tree__drag-overlay">
              <Server size={14} />
              <span>{draggingAgentName}</span>
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
  onNewConnection: () => void;
  onNewFolder: () => void;
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
  selectedConnectionIds: Set<string>;
  onConnectionClick: (connectionId: string, event: React.MouseEvent) => void;
  onTreeAreaClick: (event: React.MouseEvent) => void;
}

function RootDropZone({
  isCreatingFolder,
  onCreateFolder,
  onCancelCreateFolder,
  onNewConnection,
  onNewFolder,
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
  selectedConnectionIds,
  onConnectionClick,
  onTreeAreaClick,
}: RootDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: "root",
    data: { type: "root" },
  });
  const { active } = useDndContext();
  const isConnectionOver =
    isOver &&
    active?.data.current?.type !== "agent" &&
    active?.data.current?.type !== "agent-connection";

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={setNodeRef}
          className={`connection-list__tree${isConnectionOver ? " connection-tree__root-drop--over" : ""}`}
          onClick={onTreeAreaClick}
        >
          {isCreatingFolder && (
            <InlineFolderInput
              depth={0}
              onConfirm={onCreateFolder}
              onCancel={onCancelCreateFolder}
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
              onToggle={onToggle}
              onConnect={onConnect}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onPingHost={onPingHost}
              onDeleteFolder={onDeleteFolder}
              onCreateSubfolder={onCreateSubfolder}
              onNewConnectionInFolder={onNewConnectionInFolder}
              selectedConnectionIds={selectedConnectionIds}
              onConnectionClick={onConnectionClick}
              depth={0}
            />
          ))}
          {rootConnections.map((conn) => (
            <ConnectionItem
              key={conn.id}
              connection={conn}
              depth={0}
              isSelected={selectedConnectionIds.has(conn.id)}
              onConnect={onConnect}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onPingHost={onPingHost}
              onConnectionClick={onConnectionClick}
            />
          ))}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={onNewConnection}
            data-testid="context-root-new-connection"
          >
            <Plus size={14} /> New Connection
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={onNewFolder}
            data-testid="context-root-new-folder"
          >
            <FolderPlus size={14} /> New Folder
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
