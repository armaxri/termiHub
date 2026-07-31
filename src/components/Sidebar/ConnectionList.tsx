import { useState, useCallback, useMemo } from "react";
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
  ArrowLeftRight,
  Route,
  Search,
  X,
  FileDown,
  FileSpreadsheet,
  Link,
  Square,
} from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { SavedConnection, ConnectionFolder, InventoryHost } from "@/types/connection";
import { type AgentDefinitionInfo, importInventoryHosts } from "@/services/api";
import { toast } from "@/components/ui";
import { openLocalCommandTab } from "@/utils/openLocalCommandTab";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { Button, Tooltip, Input, ConfirmDialog } from "@/components/ui";
import { shouldShowInsecureFtpWarning } from "@/utils/ftpSecurity";
import { useConnectSavedConnection } from "@/hooks/useConnectSavedConnection";
import { useSectionResize } from "@/hooks/useSectionResize";
import { useTreeSelection } from "@/hooks/useTreeSelection";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { computeVisibleTreeNodes, type VisibleTreeNode } from "@/utils/computeVisibleTreeNodes";
import { experimentalTypeIds } from "@/utils/experimentalTypes";
import { filterConnectionTree, type ConnectionTreeFilter } from "@/utils/connectionSearch";
import {
  getJumpHosts,
  jumpHostTooltip,
  jumpHostGatewayConnection,
  findJumpHostDependents,
} from "@/utils/jumpHost";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { BulkSshImportDialog } from "./BulkSshImportDialog";
import { FleetOnboardDialog } from "./FleetOnboardDialog";
import { AgentNode } from "./AgentNode";
import { ConnectionPathDialog } from "./ConnectionPathDialog";
import { InlineFolderInput } from "./InlineFolderInput";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import "./ConnectionList.css";

/**
 * Shared keyboard-navigation / filter plumbing threaded through the tree so
 * every row participates in roving-tabindex focus and search filtering (#1356).
 *
 * Roving-tabindex focus + type-ahead are driven by the shared
 * {@link useRovingListNav} hook over the flattened visible node list; these
 * props expose the pieces each row needs to take part.
 */
interface TreeNavProps {
  /** Active search filter, or `null` when no query is entered. */
  filter: ConnectionTreeFilter | null;
  /** Roving-tabindex active index into the flattened visible node list. */
  activeIndex: number;
  /** Flattened-list index of a node by id (`-1` when not currently visible). */
  getNodeIndex: (id: string) => number;
  /** Stable per-index ref callback wiring a row into the roving-nav hook. */
  getRowRef: (index: number) => (el: HTMLButtonElement | null) => void;
  /** Keyboard handler for a tree row, keyed by its node id. */
  onTreeKeyDown: (event: React.KeyboardEvent, nodeId: string) => void;
  /** Sync the roving active index when a row gains DOM focus. */
  onRowFocus: (index: number) => void;
}

interface TreeNodeProps extends TreeNavProps {
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
  filter,
  activeIndex,
  getNodeIndex,
  getRowRef,
  onTreeKeyDown,
  onRowFocus,
}: TreeNodeProps) {
  const [creatingSubfolder, setCreatingSubfolder] = useState(false);
  // Under an active filter, matched folders are force-expanded regardless of
  // their stored state (auto-expand matches).
  const expanded = filter ? filter.visibleFolderIds.has(folder.id) : folder.isExpanded;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const visibleChildFolders = filter
    ? childFolders.filter((f) => filter.visibleFolderIds.has(f.id))
    : childFolders;
  const visibleConnections = filter
    ? connections.filter((c) => filter.matchingConnectionIds.has(c.id))
    : connections;

  const { setNodeRef, isOver } = useDroppable({
    id: folder.id,
    data: { type: "folder" },
  });
  const rowIndex = getNodeIndex(folder.id);
  const rowRef = getRowRef(rowIndex);
  // Merge the droppable ref with the roving-nav row ref so the folder button is
  // both a drop target and a focusable roving-tabindex row.
  const setRowNode = useCallback(
    (el: HTMLButtonElement | null) => {
      setNodeRef(el);
      rowRef(el);
    },
    [setNodeRef, rowRef]
  );
  const { active } = useDndContext();
  const isConnectionOver =
    isOver &&
    active?.data.current?.type !== "agent" &&
    active?.data.current?.type !== "agent-connection";

  return (
    <div className="connection-tree__node" role="none">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            ref={setRowNode}
            className={`connection-tree__folder${isConnectionOver ? " connection-tree__folder--drop-over" : ""}`}
            onClick={() => onToggle(folder.id)}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            data-testid={`folder-toggle-${folder.id}`}
            role="treeitem"
            aria-expanded={expanded}
            aria-level={depth + 1}
            tabIndex={rowIndex === activeIndex ? 0 : -1}
            onKeyDown={(e) => onTreeKeyDown(e, folder.id)}
            onFocus={() => onRowFocus(rowIndex)}
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
      {expanded && (
        <div className="connection-tree__children" role="group">
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
          {visibleChildFolders.map((child) => (
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
              filter={filter}
              activeIndex={activeIndex}
              getNodeIndex={getNodeIndex}
              getRowRef={getRowRef}
              onTreeKeyDown={onTreeKeyDown}
              onRowFocus={onRowFocus}
            />
          ))}
          {visibleConnections.map((conn) => (
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
              activeIndex={activeIndex}
              getNodeIndex={getNodeIndex}
              getRowRef={getRowRef}
              onTreeKeyDown={onTreeKeyDown}
              onRowFocus={onRowFocus}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ConnectionItemProps extends Pick<
  TreeNavProps,
  "activeIndex" | "getNodeIndex" | "getRowRef" | "onTreeKeyDown" | "onRowFocus"
> {
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
  activeIndex,
  getNodeIndex,
  getRowRef,
  onTreeKeyDown,
  onRowFocus,
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
  const rowIndex = getNodeIndex(connection.id);
  const rowRef = getRowRef(rowIndex);
  // Merge the draggable ref with the roving-nav row ref so the connection
  // button is both draggable and a focusable roving-tabindex row.
  const setRowNode = useCallback(
    (el: HTMLButtonElement | null) => {
      setDragRef(el);
      rowRef(el);
    },
    [setDragRef, rowRef]
  );

  // Desktop-local persistent-session wiring (#1881). A saved connection whose
  // type reports the `persistent` capability can run as a background session:
  // it shows the ∞ badge + a run-state dot and gains Start/Attach/Stop controls,
  // mirroring the agent-hosted definitions in AgentNode. Persistence state is
  // keyed by the plain connection id in the store's `persistentSessions` map.
  const persistentCapable = useAppStore(
    (s) =>
      s.connectionTypes.find((t) => t.typeId === connection.config.type)?.capabilities.persistent ??
      false
  );
  const persistentEntry = useAppStore((s) => s.persistentSessions[connection.id]);
  const startPersistentSession = useAppStore((s) => s.startPersistentSession);
  const attachPersistentSession = useAppStore((s) => s.attachPersistentSession);
  const stopPersistentSession = useAppStore((s) => s.stopPersistentSession);

  const runState = persistentEntry?.state ?? null;
  const isPersistentRunning = runState === "running" || runState === "attached";
  const isPersistentTransitioning = runState === "starting" || runState === "stopping";
  const hasPersistentError = runState === "error";
  const isPersistentStopped = !runState || runState === "stopped" || hasPersistentError;

  const handleStartPersistent = useCallback(() => {
    void startPersistentSession(connection.id);
  }, [startPersistentSession, connection.id]);

  const handleAttachPersistent = useCallback(() => {
    void attachPersistentSession(connection.id);
  }, [attachPersistentSession, connection.id]);

  const handleStopPersistent = useCallback(() => {
    void stopPersistentSession(connection.id);
  }, [stopPersistentSession, connection.id]);

  let className = "connection-tree__item";
  if (isDragging) className += " connection-tree__item--dragging";
  if (isSelected) className += " connection-tree__item--selected";
  if (persistentCapable) className += " connection-tree__item--persistent";

  const jumpHosts = getJumpHosts(connection.config);
  const [showConnectionPath, setShowConnectionPath] = useState(false);

  return (
    <>
      {showConnectionPath && (
        <ConnectionPathDialog
          open={showConnectionPath}
          connection={connection}
          onClose={() => setShowConnectionPath(false)}
        />
      )}
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="connection-tree__item-row" role="none">
            <button
              ref={setRowNode}
              className={className}
              style={{ paddingLeft: `${depth * 16 + 8}px` }}
              onClick={(e) => onConnectionClick(connection.id, e)}
              onDoubleClick={() => onConnect(connection)}
              title={`Double-click to connect: ${connection.name}`}
              data-testid={`connection-item-${connection.id}`}
              {...attributes}
              {...listeners}
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={isSelected}
              tabIndex={rowIndex === activeIndex ? 0 : -1}
              onKeyDown={(e) => onTreeKeyDown(e, connection.id)}
              onFocus={() => onRowFocus(rowIndex)}
            >
              <ConnectionIcon config={connection.config} customIcon={connection.icon} size={16} />
              <span className="connection-tree__label">{connection.name}</span>
              {jumpHosts.length > 0 && (
                <span
                  className="connection-tree__jump-badge"
                  title={jumpHostTooltip(jumpHosts, connection.name)}
                  data-testid={`connection-jump-badge-${connection.id}`}
                >
                  <ArrowLeftRight size={12} />
                  {jumpHosts.length > 1 && (
                    <span className="connection-tree__jump-count">{jumpHosts.length}</span>
                  )}
                </span>
              )}
              {/* Persistence surfacing (#2099): normal desktop-local
                  connections (ssh/docker/wsl/serial/local) are multi-instance
                  and die with the window, so they carry NO persistence marker —
                  no ∞, no hourglass, no state dot. The ∞ lives only on agent
                  persistent shells (see AgentNode.tsx). */}
              <span className="connection-tree__type">{connection.config.type}</span>
              {persistentCapable && !isPersistentTransitioning && (
                <span className="connection-tree__persistent-actions">
                  {isPersistentStopped ? (
                    <Tooltip content="Start session" side="top">
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        icon={<Play size={12} />}
                        aria-label="Start session"
                        data-testid={`persistent-start-${connection.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartPersistent();
                        }}
                      />
                    </Tooltip>
                  ) : (
                    <>
                      <Tooltip content="Attach new tab" side="top">
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          icon={<Link size={12} />}
                          aria-label="Attach new tab"
                          data-testid={`persistent-attach-${connection.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAttachPersistent();
                          }}
                        />
                      </Tooltip>
                      <Tooltip content="Stop session" side="top">
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          icon={<Square size={12} />}
                          aria-label="Stop session"
                          data-testid={`persistent-stop-${connection.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStopPersistent();
                          }}
                        />
                      </Tooltip>
                    </>
                  )}
                </span>
              )}
            </button>
            {!persistentCapable && (
              <Tooltip content="Connect" side="right">
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  className="connection-tree__connect"
                  icon={<Play size={14} />}
                  aria-label={`Connect to ${connection.name}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onConnect(connection);
                  }}
                  data-testid={`connection-connect-${connection.id}`}
                />
              </Tooltip>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="context-menu__content">
            {persistentCapable && isPersistentStopped && (
              <ContextMenu.Item
                className="context-menu__item"
                onSelect={handleStartPersistent}
                data-testid="context-connection-start-persistent"
              >
                <Play size={14} /> Start Session
              </ContextMenu.Item>
            )}
            {persistentCapable && isPersistentRunning && (
              <>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={handleAttachPersistent}
                  data-testid="context-connection-attach-persistent"
                >
                  <Link size={14} /> Attach New Tab
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="context-menu__item context-menu__item--danger"
                  onSelect={handleStopPersistent}
                  data-testid="context-connection-stop-persistent"
                >
                  <Square size={14} /> Stop Session
                </ContextMenu.Item>
              </>
            )}
            {persistentCapable && !isPersistentTransitioning && (
              <ContextMenu.Separator className="context-menu__separator" />
            )}
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
            {jumpHosts.length > 0 && (
              <>
                <ContextMenu.Separator className="context-menu__separator" />
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={() => {
                    const gateway = jumpHostGatewayConnection(connection);
                    if (gateway) onConnect(gateway);
                  }}
                  data-testid="context-connection-open-jump-host"
                >
                  <Server size={14} /> Open Jump Host Terminal
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={() => setShowConnectionPath(true)}
                  data-testid="context-connection-show-path"
                >
                  <Route size={14} /> Show Connection Path
                </ContextMenu.Item>
                <ContextMenu.Separator className="context-menu__separator" />
              </>
            )}
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
    </>
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
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [fleetRows, setFleetRows] = useState<InventoryHost[] | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [agentFilterQuery, setAgentFilterQuery] = useState("");
  const [draggingConnection, setDraggingConnection] = useState<SavedConnection | null>(null);
  const [draggingAgentName, setDraggingAgentName] = useState<string | null>(null);
  const [draggingAgentDef, setDraggingAgentDef] = useState<AgentDefinitionInfo | null>(null);
  const [draggingSelectionCount, setDraggingSelectionCount] = useState(0);
  /** Pending jump-host delete confirmation (set when the target is referenced). */
  const [deleteConfirm, setDeleteConfirm] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);
  // The saved-connection / folder inventory, sourced from the projected
  // `connections` region when it faithfully mirrors `appStore`, else `appStore`
  // verbatim (#2225 render cut).
  const { folders, connections: allConnections } = useProjectedConnections();
  const connectionTypes = useAppStore((s) => s.connectionTypes);
  // The ordered remote-agent list + per-agent saved-definition map, sourced from
  // the projected `agents` region when it faithfully mirrors `appStore`, else
  // `appStore` verbatim (#2226 render cut).
  const { remoteAgents, agentDefinitions } = useProjectedAgents();
  const experimental = useExperimentalFeatures();

  // Gate experimental (graphical remote-desktop) connections out of the sidebar
  // when the flag is off (#1705), so an already-saved VNC/RDP/mock connection is
  // hidden from normal navigation exactly as the type picker hides its type.
  const connections = useMemo(() => {
    if (experimental) return allConnections;
    const gated = experimentalTypeIds(connectionTypes);
    if (gated.size === 0) return allConnections;
    return allConnections.filter((c) => !gated.has(c.config.type));
  }, [experimental, allConnections, connectionTypes]);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const updateConnection = useAppStore((s) => s.updateConnection);
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const deleteConnection = useAppStore((s) => s.deleteConnection);
  const bulkDeleteConnections = useAppStore((s) => s.bulkDeleteConnections);
  const bulkAddConnections = useAppStore((s) => s.bulkAddConnections);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const addFolder = useAppStore((s) => s.addFolder);
  const duplicateConnection = useAppStore((s) => s.duplicateConnection);
  const moveConnectionToFolder = useAppStore((s) => s.moveConnectionToFolder);
  const bulkMoveConnectionsToFolder = useAppStore((s) => s.bulkMoveConnectionsToFolder);
  const reorderRemoteAgents = useAppStore((s) => s.reorderRemoteAgents);
  const moveAgentDefToFolder = useAppStore((s) => s.moveAgentDefToFolder);
  const bulkMoveAgentDefsToFolder = useAppStore((s) => s.bulkMoveAgentDefsToFolder);

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 8 },
  });
  const sensors = useSensors(pointerSensor);

  const rootFolders = useMemo(() => folders.filter((f) => f.parentId === null), [folders]);
  const rootConnections = useMemo(
    () => connections.filter((c) => c.folderId === null),
    [connections]
  );

  // Live search filter over the connection tree (name/host). `null` when empty.
  const filter = useMemo(
    () => filterConnectionTree(filterQuery, folders, connections),
    [filterQuery, folders, connections]
  );

  // Flattened, in-order list of the rows actually rendered — drives both
  // roving-tabindex keyboard navigation and Shift+Click range selection, so
  // both stay in sync with the active filter.
  const treeNodes = useMemo(
    () => computeVisibleTreeNodes(folders, connections, filter),
    [folders, connections, filter]
  );

  const flatVisibleConnectionIds = useMemo(
    () => treeNodes.filter((n) => n.kind === "connection").map((n) => n.id),
    [treeNodes]
  );

  const {
    selectedIds: selectedConnectionIds,
    handleItemClick: handleConnectionClick,
    handleAreaClick: handleTreeAreaClick,
    clearSelection: clearConnectionSelection,
    selectSingle: selectConnectionSingle,
  } = useTreeSelection(flatVisibleConnectionIds);

  // Flat-list index lookup by node id, so each row can resolve its position in
  // the roving-nav item array (`treeNodes`) for tabindex and ref wiring.
  const nodeIndexById = useMemo(() => {
    const map = new Map<string, number>();
    treeNodes.forEach((node, index) => map.set(node.id, index));
    return map;
  }, [treeNodes]);
  const getNodeIndex = useCallback((id: string) => nodeIndexById.get(id) ?? -1, [nodeIndexById]);

  // Type-ahead label for a node: a connection's name, or a folder's name.
  const folderNameById = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);
  const getNodeLabel = useCallback(
    (node: VisibleTreeNode) =>
      node.kind === "connection"
        ? (node.connection?.name ?? "")
        : (folderNameById.get(node.id) ?? ""),
    [folderNameById]
  );

  // Roving-tabindex keyboard navigation + type-ahead over the flattened visible
  // rows, shared with the file browser (#1461). The hook owns the active focus
  // index, type-ahead buffer, and per-row ref wiring; tree-specific keys
  // (ArrowLeft/ArrowRight collapse/expand, Space) are layered on below.
  const { activeIndex, setActiveIndex, getRowRef, focusRow, makeKeyDownHandler } = useRovingListNav<
    VisibleTreeNode,
    HTMLButtonElement
  >(treeNodes, getNodeLabel);

  // The plain-FTP connection awaiting the user's decision in the insecure-
  // connection warning modal, or null when the modal is closed. The modal is
  // shown before any control connection is opened (see `handleConnect`).
  const [insecureFtpConnection, setInsecureFtpConnection] = useState<SavedConnection | null>(null);
  const [insecureFtpDontWarn, setInsecureFtpDontWarn] = useState(false);

  const { connect: performConnect } = useConnectSavedConnection();

  // Connect entry point: for a plain-FTP connection that has not been suppressed,
  // surface the insecure-connection warning modal *before* the control
  // connection opens; every other connection proceeds immediately.
  const handleConnect = useCallback(
    async (connection: SavedConnection) => {
      if (shouldShowInsecureFtpWarning(connection.config)) {
        setInsecureFtpDontWarn(false);
        setInsecureFtpConnection(connection);
        return;
      }
      await performConnect(connection);
    },
    [performConnect]
  );

  // "Connect Anyway": optionally persist the per-connection suppression, then
  // proceed with the connect. Password is never written to connections.json —
  // `updateConnection` strips it before persisting.
  const handleInsecureFtpConfirm = useCallback(() => {
    const connection = insecureFtpConnection;
    setInsecureFtpConnection(null);
    if (!connection) return;
    if (insecureFtpDontWarn) {
      updateConnection({
        ...connection,
        config: {
          ...connection.config,
          config: { ...connection.config.config, suppressSecurityWarning: true },
        },
      });
    }
    void performConnect(connection);
  }, [insecureFtpConnection, insecureFtpDontWarn, updateConnection, performConnect]);

  const handleInsecureFtpCancel = useCallback(() => {
    setInsecureFtpConnection(null);
  }, []);

  // While a search filter is active, folders are force-expanded by the render
  // logic and their stored `isExpanded` is ignored (#1378). Suppress folder
  // toggles (click + keyboard) so a toggle has no hidden effect and clearing the
  // filter restores exactly the expansion state the tree had before filtering.
  const handleToggleFolder = useCallback(
    (folderId: string) => {
      if (filter) return;
      toggleFolder(folderId);
    },
    [filter, toggleFolder]
  );

  // Activate a row: folders toggle, connections connect — shared by Enter (via
  // the roving-nav handler) and Space (tree-specific handler below).
  const activateNode = useCallback(
    (node: VisibleTreeNode) => {
      if (node.kind === "folder") handleToggleFolder(node.id);
      else if (node.connection) handleConnect(node.connection);
    },
    [handleToggleFolder, handleConnect]
  );

  // Shared roving-nav keydown handler (Up/Down, Home/End, Enter, type-ahead,
  // Escape). The tree navigates focus without mutating the multi-selection, so
  // the selection callbacks are intentionally inert; the drag/bulk selection is
  // driven by mouse via useTreeSelection.
  const rovingKeyDown = useMemo(
    () =>
      makeKeyDownHandler({
        onActivate: activateNode,
        onNavigateUp: () => {},
        onRename: () => {},
        onSelectAll: () => {},
        onClearSelection: clearConnectionSelection,
        getAnchorIndex: () => -1,
        onSelectRange: () => {},
        onSelectSingle: () => {},
      }),
    [makeKeyDownHandler, activateNode, clearConnectionSelection]
  );

  // Per-row keydown: tree-specific keys (expand/collapse, move to parent/child,
  // Space to activate) are handled here; everything else delegates to the
  // shared roving-nav handler.
  const handleTreeKeyDown = useCallback(
    (event: React.KeyboardEvent, nodeId: string) => {
      const index = getNodeIndex(nodeId);
      const node = treeNodes[index];
      if (!node) return;
      switch (event.key) {
        case "ArrowRight": {
          if (node.kind !== "folder") return;
          event.preventDefault();
          if (!node.isExpanded && node.hasChildren) {
            handleToggleFolder(node.id);
          } else if (node.isExpanded) {
            const child = treeNodes[index + 1];
            if (child && child.depth > node.depth) focusRow(index + 1);
          }
          return;
        }
        case "ArrowLeft": {
          event.preventDefault();
          if (node.kind === "folder" && node.isExpanded) {
            handleToggleFolder(node.id);
          } else if (node.parentId) {
            const parentIndex = getNodeIndex(node.parentId);
            if (parentIndex >= 0) focusRow(parentIndex);
          }
          return;
        }
        case " ": {
          event.preventDefault();
          activateNode(node);
          return;
        }
        default:
          rovingKeyDown(event);
      }
    },
    [treeNodes, getNodeIndex, focusRow, activateNode, rovingKeyDown, handleToggleFolder]
  );

  // Sync the roving active index when a row gains DOM focus (Tab, click).
  const handleRowFocus = useCallback((index: number) => setActiveIndex(index), [setActiveIndex]);

  const handleFilterKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        // Top hit = first connection row in filter-aware visual order.
        const topHitId = flatVisibleConnectionIds[0];
        if (topHitId) {
          const target = connections.find((c) => c.id === topHitId);
          if (target) handleConnect(target);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        setFilterQuery("");
      }
    },
    [flatVisibleConnectionIds, connections, handleConnect]
  );

  const handleEdit = useCallback(
    (connectionId: string) => {
      openConnectionEditorTab(connectionId);
    },
    [openConnectionEditorTab]
  );

  const handleDelete = useCallback(
    (connectionId: string) => {
      const bulk = selectedConnectionIds.size > 1 && selectedConnectionIds.has(connectionId);
      const targetIds = bulk ? [...selectedConnectionIds] : [connectionId];
      const doDelete = () => {
        if (bulk) {
          bulkDeleteConnections(targetIds);
          clearConnectionSelection();
        } else {
          deleteConnection(connectionId);
        }
      };

      // Always confirm a delete — it is irreversible (#1343). Build a
      // count-aware base message, then append a jump-host warning when any
      // target is still referenced as a saved jump host (#941): deleting it
      // would silently break those connections' chains.
      const target = connections.find((c) => c.id === connectionId);
      const baseMessage = bulk
        ? `Delete ${targetIds.length} connections? This cannot be undone.`
        : `Delete “${target?.name ?? "this connection"}”? This cannot be undone.`;

      const dependents = findJumpHostDependents(connections, targetIds);
      let message = baseMessage;
      if (dependents.length > 0) {
        const names = dependents.map((d) => d.name).join(", ");
        const subject = bulk ? "These connections are" : "This connection is";
        message = `${baseMessage} ${subject} used as a jump host by ${dependents.length} other connection(s): ${names}.`;
      }

      setDeleteConfirm({
        message,
        onConfirm: () => {
          setDeleteConfirm(null);
          doDelete();
        },
      });
    },
    [
      deleteConnection,
      bulkDeleteConnections,
      selectedConnectionIds,
      clearConnectionSelection,
      connections,
    ]
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

  /**
   * Pick a CSV / inventory file and open the fleet-onboard dialog with its hosts
   * (#1961). A cancelled picker is a no-op; a read/parse failure or an
   * empty/host-less file surfaces a toast rather than an empty dialog.
   */
  const handleImportCsv = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Inventory", extensions: ["csv", "txt", "tsv"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const hosts = await importInventoryHosts(selected);
      if (hosts.length === 0) {
        toast.info("No hosts found in that file.");
        return;
      }
      setFleetRows(hosts);
    } catch {
      toast.error("Could not read that inventory file.");
    }
  }, []);

  const handleNewConnectionInFolder = useCallback(
    (folderId: string) => {
      openConnectionEditorTab("new", folderId);
    },
    [openConnectionEditorTab]
  );

  const handleNewAgent = useCallback(() => {
    openConnectionEditorTab("new-remote-agent");
  }, [openConnectionEditorTab]);

  const handlePingHost = useCallback(async (connection: SavedConnection) => {
    const cfg = connection.config.config as unknown as Record<string, unknown>;
    const host = cfg.host as string | undefined;
    if (!host) return;
    await openLocalCommandTab(`Ping ${host}`, `ping ${host}`);
  }, []);

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

  // The Remote Agents section only occupies a flex slot when it is both
  // rendered (experimental) and expanded. Keying it on `experimental` alone
  // (ignoring `remoteAgentsCollapsed`) left the collapsed wrapper flex-growing
  // to fill the column, so its contents folded away but the empty space
  // remained (#1822).
  const outerSectionsExpanded = useMemo(
    () => [!localCollapsed, experimental && !remoteAgentsCollapsed] as boolean[],
    [localCollapsed, experimental, remoteAgentsCollapsed]
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
          data-testid="connection-list-group-connections"
        >
          <div
            className="connection-list__group-header"
            data-testid="sidebar-group-header-connections"
          >
            <button
              className="connection-list__group-toggle"
              onClick={() => setLocalCollapsed((v) => !v)}
              aria-expanded={!localCollapsed}
              data-testid="connection-list-group-toggle"
            >
              <LocalChevron size={16} className="connection-tree__chevron" />
              <span className="connection-list__group-title">Connections</span>
            </button>
            <div className="connection-list__group-actions">
              <Tooltip content="New Folder" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<FolderPlus size={16} />}
                  onClick={() => {
                    setLocalCollapsed(false);
                    setCreatingFolder(true);
                  }}
                  aria-label="New Folder"
                  data-testid="connection-list-new-folder"
                />
              </Tooltip>
              <Tooltip content="New Connection" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Plus size={16} />}
                  onClick={handleNewConnection}
                  aria-label="New Connection"
                  data-testid="connection-list-new-connection"
                />
              </Tooltip>
              <Tooltip content="Import from ~/.ssh/config" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<FileDown size={16} />}
                  onClick={() => setBulkImportOpen(true)}
                  aria-label="Import from ~/.ssh/config"
                  data-testid="connection-list-import-ssh-config"
                />
              </Tooltip>
              <Tooltip content="Onboard hosts from a CSV / inventory" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<FileSpreadsheet size={16} />}
                  onClick={handleImportCsv}
                  aria-label="Onboard hosts from a CSV / inventory"
                  data-testid="connection-list-import-csv"
                />
              </Tooltip>
            </div>
          </div>
          {!localCollapsed && (
            <div className="connection-list__filter">
              <Search size={14} className="connection-list__filter-icon" aria-hidden="true" />
              <Input
                className="connection-list__filter-input"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                onKeyDown={handleFilterKeyDown}
                placeholder="Filter connections…"
                aria-label="Filter connections"
                data-testid="connection-filter-input"
              />
              {filterQuery && (
                <Tooltip content="Clear filter" side="top">
                  <button
                    type="button"
                    className="connection-list__filter-clear"
                    onClick={() => setFilterQuery("")}
                    aria-label="Clear filter"
                    data-testid="connection-filter-clear"
                  >
                    <X size={14} />
                  </button>
                </Tooltip>
              )}
            </div>
          )}
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
              onToggle={handleToggleFolder}
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
              filter={filter}
              activeIndex={activeIndex}
              getNodeIndex={getNodeIndex}
              getRowRef={getRowRef}
              onTreeKeyDown={handleTreeKeyDown}
              onRowFocus={handleRowFocus}
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
                  aria-expanded={!remoteAgentsCollapsed}
                  data-testid="connection-list-remote-agents-toggle"
                >
                  <RemoteAgentsChevron size={16} className="connection-tree__chevron" />
                  <span className="connection-list__group-title">Remote Agents</span>
                </button>
                <div className="connection-list__group-actions">
                  <Tooltip content="New Remote Agent" side="top">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon={<Plus size={16} />}
                      onClick={handleNewAgent}
                      aria-label="New Remote Agent"
                      data-testid="connection-list-new-agent"
                    />
                  </Tooltip>
                </div>
              </div>
              {!remoteAgentsCollapsed && (
                <div className="connection-list__filter">
                  <Search size={14} className="connection-list__filter-icon" aria-hidden="true" />
                  <Input
                    className="connection-list__filter-input"
                    value={agentFilterQuery}
                    onChange={(e) => setAgentFilterQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setAgentFilterQuery("");
                      }
                    }}
                    placeholder="Filter agent connections…"
                    aria-label="Filter agent connections"
                    data-testid="agent-filter-input"
                  />
                  {agentFilterQuery && (
                    <Tooltip content="Clear filter" side="top">
                      <button
                        type="button"
                        className="connection-list__filter-clear"
                        onClick={() => setAgentFilterQuery("")}
                        aria-label="Clear agent filter"
                        data-testid="agent-filter-clear"
                      >
                        <X size={14} />
                      </button>
                    </Tooltip>
                  )}
                </div>
              )}
              {!remoteAgentsCollapsed && (
                <SortableContext
                  items={remoteAgents.map((a) => a.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div
                    className="connection-list__agents-scroll"
                    data-testid="remote-agents-scroll"
                  >
                    {/*
                      Every agent renders at its natural content height so the
                      whole list overflows and scrolls in this container — an
                      expanded agent's tree is not squeezed into a flex slice
                      (which previously fixed the total height and defeated the
                      scroll while clipping expanded content), it just makes the
                      list taller and reachable by scrolling (#2116).
                    */}
                    {remoteAgents.map((agent) => (
                      <AgentNode key={agent.id} agent={agent} filterQuery={agentFilterQuery} />
                    ))}
                  </div>
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
      <ConfirmDeleteDialog
        open={deleteConfirm !== null}
        message={deleteConfirm?.message ?? ""}
        onConfirm={() => deleteConfirm?.onConfirm()}
        onCancel={() => setDeleteConfirm(null)}
      />
      <ConfirmDialog
        open={insecureFtpConnection !== null}
        title="Insecure Connection"
        message={
          <>
            <p>
              Plain FTP transmits your username, password, and all data in cleartext. Anyone on the
              network path can intercept your credentials and files.
            </p>
            <p>Consider using FTPS (FTP over TLS) if the server supports it.</p>
          </>
        }
        confirmLabel="Connect Anyway"
        cancelLabel="Cancel"
        confirmVariant="primary"
        dontAskAgain={{
          checked: insecureFtpDontWarn,
          onChange: setInsecureFtpDontWarn,
          label: "Don't warn again for this connection",
        }}
        onConfirm={handleInsecureFtpConfirm}
        onCancel={handleInsecureFtpCancel}
        data-testid="insecure-ftp-warning"
      />
      <BulkSshImportDialog
        open={bulkImportOpen}
        onOpenChange={setBulkImportOpen}
        folders={folders}
        existingConnections={connections}
        onImport={bulkAddConnections}
      />
      <FleetOnboardDialog
        open={fleetRows !== null}
        onOpenChange={(open) => {
          if (!open) setFleetRows(null);
        }}
        rows={fleetRows ?? []}
        sourceLabel="a CSV inventory"
      />
    </div>
  );
}

interface RootDropZoneProps extends TreeNavProps {
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
  filter,
  activeIndex,
  getNodeIndex,
  getRowRef,
  onTreeKeyDown,
  onRowFocus,
}: RootDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: "root",
    data: { type: "root" },
  });
  const visibleRootFolders = filter
    ? rootFolders.filter((f) => filter.visibleFolderIds.has(f.id))
    : rootFolders;
  const visibleRootConnections = filter
    ? rootConnections.filter((c) => filter.matchingConnectionIds.has(c.id))
    : rootConnections;
  const hasVisibleResults = visibleRootFolders.length + visibleRootConnections.length > 0;
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
          role="tree"
          aria-label="Connections"
        >
          {isCreatingFolder && (
            <InlineFolderInput
              depth={0}
              onConfirm={onCreateFolder}
              onCancel={onCancelCreateFolder}
            />
          )}
          {filter && !hasVisibleResults && (
            <p className="connection-list__empty" role="status">
              No connections match “{filter.query}”.
            </p>
          )}
          {visibleRootFolders.map((folder) => (
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
              filter={filter}
              activeIndex={activeIndex}
              getNodeIndex={getNodeIndex}
              getRowRef={getRowRef}
              onTreeKeyDown={onTreeKeyDown}
              onRowFocus={onRowFocus}
            />
          ))}
          {visibleRootConnections.map((conn) => (
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
              activeIndex={activeIndex}
              getNodeIndex={getNodeIndex}
              getRowRef={getRowRef}
              onTreeKeyDown={onTreeKeyDown}
              onRowFocus={onRowFocus}
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
