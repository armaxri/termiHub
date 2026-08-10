/**
 * Agent folder node in the sidebar.
 *
 * Renders a remote agent as an expandable section with connection state,
 * active sessions, and a folder tree of saved connections (mirroring the
 * local connections experience).
 */

import { useState, useCallback, useMemo, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { useDraggable, useDroppable, useDndContext, useDndMonitor } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
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
  Container,
  Globe,
  Wifi,
  Upload,
  Folder,
  FolderPlus,
  Zap,
  Copy,
  Link,
  XCircle,
  Unplug,
  Power,
} from "lucide-react";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { Button, Tooltip, toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { frontendLog } from "@/utils/frontendLog";
import { RemoteAgentDefinition } from "@/types/connection";
import {
  AgentSessionInfo,
  AgentDefinitionInfo,
  AgentFolderInfo,
  removeCredential,
  storeCredential,
  cancelConnectAgent,
} from "@/services/api";
import { classifyAgentError, ClassifiedAgentError } from "@/utils/classifyAgentError";
import { resolveAgentUpdateState } from "@/utils/agentVersion";
import { useDesktopVersion } from "@/hooks/useDesktopVersion";
import { AgentVersionBadge } from "@/components/AgentVersionBadge/AgentVersionBadge";
import { AgentUpdateBanner } from "@/components/AgentUpdateBanner";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { useTreeSelection } from "@/hooks/useTreeSelection";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { AgentTreeFilter, filterAgentTree } from "@/utils/agentTreeSearch";
import { computeAgentTreeNodes, type AgentVisibleNode } from "@/utils/computeAgentTreeNodes";
import { AgentSetupDialog } from "./AgentSetupDialog";
import { ConnectionErrorDialog } from "./ConnectionErrorDialog";
import { InlineFolderInput } from "./InlineFolderInput";
import { PersistentStateDot } from "./PersistentStateDot";

const EMPTY_SESSIONS: AgentSessionInfo[] = [];
const EMPTY_DEFINITIONS: AgentDefinitionInfo[] = [];
const EMPTY_FOLDERS: AgentFolderInfo[] = [];

/** CSS modifier class for each connection state dot. */
const STATE_DOT_CLASSES: Record<string, string> = {
  connected: "agent-node__state-dot--connected",
  connecting: "agent-node__state-dot--connecting",
  reconnecting: "agent-node__state-dot--reconnecting",
  disconnected: "agent-node__state-dot--disconnected",
};

/**
 * Shared roving-tabindex / filter plumbing threaded through the agent tree so
 * every row participates in keyboard navigation and search filtering (#1379),
 * mirroring the Connections tree. Roving focus + type-ahead are driven by the
 * shared {@link useRovingListNav} hook over the flattened visible node list.
 */
interface AgentTreeNavProps {
  /** Active search filter, or `null` when no query is entered. */
  filter: AgentTreeFilter | null;
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
  /** Toggle a folder's expansion (suppressed while a filter is active). */
  onToggleFolder: (folderId: string) => void;
}

/** Roving-nav props needed by a leaf (definition) row. */
type AgentItemNavProps = Pick<
  AgentTreeNavProps,
  "activeIndex" | "getNodeIndex" | "getRowRef" | "onTreeKeyDown" | "onRowFocus"
>;

/** Icon for a session/connection type string. */
function SessionTypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  switch (type) {
    case "serial":
      return <Cable size={size} />;
    case "docker":
      return <Container size={size} />;
    case "ssh":
      return <Wifi size={size} />;
    case "telnet":
      return <Globe size={size} />;
    default:
      return <Terminal size={size} />;
  }
}

// ── Agent connection item ────────────────────────────────────────────

interface AgentConnectionItemProps extends AgentItemNavProps {
  agentId: string;
  definition: AgentDefinitionInfo;
  depth: number;
  isSelected: boolean;
  selectedDefIds: string[];
  onOpen: (def: AgentDefinitionInfo) => void;
  onEdit: (def: AgentDefinitionInfo) => void;
  onDuplicate: (def: AgentDefinitionInfo) => void;
  onConnectionClick: (defId: string, event: React.MouseEvent) => void;
  onStartPersistent: (agentId: string, def: AgentDefinitionInfo) => void;
  onAttachPersistent: (agentId: string, def: AgentDefinitionInfo) => void;
  onStopPersistent: (agentId: string, def: AgentDefinitionInfo) => void;
}

function AgentConnectionItem({
  agentId,
  definition,
  depth,
  isSelected,
  selectedDefIds,
  onOpen,
  onEdit,
  onDuplicate,
  onConnectionClick,
  onStartPersistent,
  onAttachPersistent,
  onStopPersistent,
  activeIndex,
  getNodeIndex,
  getRowRef,
  onTreeKeyDown,
  onRowFocus,
}: AgentConnectionItemProps) {
  const deleteAgentDef = useAppStore((s) => s.deleteAgentDef);
  const persistentEntry = useAppStore((s) => s.persistentSessions[`${agentId}:${definition.id}`]);
  const runState = persistentEntry?.state ?? null;

  const effectiveSelectedIds =
    isSelected && selectedDefIds.length > 1 ? selectedDefIds : [definition.id];

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `agent-def:${agentId}:${definition.id}`,
    data: {
      type: "agent-connection",
      definition,
      agentId,
      selectedDefIds: effectiveSelectedIds,
      selectionCount: effectiveSelectedIds.length,
    },
  });

  const rowIndex = getNodeIndex(definition.id);
  const rowRef = getRowRef(rowIndex);
  // Merge the draggable ref with the roving-nav row ref so the definition button
  // is both draggable and a focusable roving-tabindex row.
  const setRowNode = useCallback(
    (el: HTMLButtonElement | null) => {
      setDragRef(el);
      rowRef(el);
    },
    [setDragRef, rowRef]
  );

  let className = "connection-tree__item";
  if (isDragging) className += " connection-tree__item--dragging";
  if (isSelected) className += " connection-tree__item--selected";
  if (definition.persistent) className += " connection-tree__item--persistent";

  const isRunning = runState === "running" || runState === "attached";
  const isTransitioning = runState === "starting" || runState === "stopping";
  const hasError = runState === "error";

  const stateDotClass = isRunning
    ? "connection-tree__state-dot--running"
    : isTransitioning
      ? "connection-tree__state-dot--transitioning"
      : hasError
        ? "connection-tree__state-dot--error"
        : "connection-tree__state-dot--stopped";

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          ref={setRowNode}
          className={className}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={(e) => onConnectionClick(definition.id, e)}
          onDoubleClick={() => {
            if (definition.persistent) {
              // Persistent shells must always go through the persistent-session
              // machinery so the sidebar state dot reflects the real state.
              // Routing a stopped shell through onOpen would create an unmanaged
              // tab via createTerminal and leave the dot grey.
              onAttachPersistent(agentId, definition);
            } else {
              onOpen(definition);
            }
          }}
          title={`${definition.name} (${definition.sessionType}${definition.persistent ? ", persistent" : ""})`}
          {...attributes}
          {...listeners}
          role="treeitem"
          aria-level={depth}
          aria-selected={isSelected}
          tabIndex={rowIndex === activeIndex ? 0 : -1}
          onKeyDown={(e) => onTreeKeyDown(e, definition.id)}
          onFocus={() => onRowFocus(rowIndex)}
        >
          <ConnectionIcon
            config={{
              type: "remote-session",
              config: {
                sessionType: definition.sessionType,
                shell: (definition.config as Record<string, unknown>).shell as string | undefined,
              },
            }}
            customIcon={definition.icon}
            size={14}
          />
          {definition.persistent && (
            <PersistentStateDot
              runState={runState}
              stateDotClass={stateDotClass}
              connectionId={`${agentId}:${definition.id}`}
              dotTestId={`persistent-state-dot-${definition.id}`}
            />
          )}
          <span className="connection-tree__label">{definition.name}</span>
          {/* Agent-backed persistence (#2086): the ∞ is reserved for sessions
              that live on the remote agent and survive closing termiHub AND
              powering off / restarting this machine. The tooltip states exactly
              that so the strong claim is never confused with the desktop-local
              (app-open-only) tier. */}
          {definition.persistent && (
            <span
              className="connection-tree__persistent-badge"
              title="Persistent session — lives on the agent and survives closing termiHub and restarting this machine."
              data-testid={`persistent-badge-${definition.id}`}
            >
              ∞
            </span>
          )}
          {definition.persistent ? (
            <span className="connection-tree__persistent-actions">
              {!runState || runState === "stopped" || runState === "error" ? (
                <Tooltip content="Start session" side="top">
                  <Button
                    variant="ghost"
                    size="xs"
                    iconOnly
                    icon={<Play size={12} />}
                    aria-label="Start session"
                    data-testid={`persistent-start-${definition.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartPersistent(agentId, definition);
                    }}
                  />
                </Tooltip>
              ) : isRunning ? (
                <>
                  <Tooltip content="Attach new tab" side="top">
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      icon={<Link size={12} />}
                      aria-label="Attach new tab"
                      data-testid={`persistent-attach-${definition.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAttachPersistent(agentId, definition);
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
                      data-testid={`persistent-stop-${definition.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStopPersistent(agentId, definition);
                      }}
                    />
                  </Tooltip>
                </>
              ) : null}
            </span>
          ) : (
            <span className="connection-tree__type">{definition.sessionType}</span>
          )}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          {definition.persistent &&
            (!runState || runState === "stopped" || runState === "error") && (
              <>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={() => onStartPersistent(agentId, definition)}
                  data-testid="context-agent-def-start-persistent"
                >
                  <Play size={14} />
                  Start Session
                </ContextMenu.Item>
                <ContextMenu.Separator className="context-menu__separator" />
              </>
            )}
          {definition.persistent && isRunning && (
            <>
              <ContextMenu.Item
                className="context-menu__item"
                onSelect={() => onAttachPersistent(agentId, definition)}
                data-testid="context-agent-def-attach-persistent"
              >
                <Link size={14} />
                Attach New Tab
              </ContextMenu.Item>
              <ContextMenu.Item
                className="context-menu__item context-menu__item--danger"
                onSelect={() => onStopPersistent(agentId, definition)}
                data-testid="context-agent-def-stop-persistent"
              >
                <Square size={14} />
                Stop Session
              </ContextMenu.Item>
              <ContextMenu.Separator className="context-menu__separator" />
            </>
          )}
          {!definition.persistent && (
            <ContextMenu.Item className="context-menu__item" onSelect={() => onOpen(definition)}>
              <Play size={14} />
              Connect
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onEdit(definition)}
            data-testid="context-agent-def-edit"
          >
            <Pencil size={14} />
            Edit
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onDuplicate(definition)}
            data-testid="context-agent-def-duplicate"
          >
            <Copy size={14} />
            Duplicate
          </ContextMenu.Item>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item context-menu__item--danger"
            onSelect={() => deleteAgentDef(agentId, definition.id)}
          >
            <Trash2 size={14} />
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// ── Agent folder node (recursive) ───────────────────────────────────

interface AgentFolderNodeProps extends AgentTreeNavProps {
  agentId: string;
  folder: AgentFolderInfo;
  allFolders: AgentFolderInfo[];
  allDefinitions: AgentDefinitionInfo[];
  depth: number;
  selectedDefIds: Set<string>;
  allSelectedDefIds: string[];
  onOpenDefinition: (def: AgentDefinitionInfo) => void;
  onNewConnection: (folderId: string | null) => void;
  onEditDefinition: (def: AgentDefinitionInfo) => void;
  onDuplicateDefinition: (def: AgentDefinitionInfo) => void;
  onDefinitionClick: (defId: string, event: React.MouseEvent) => void;
  onStartPersistent: (agentId: string, def: AgentDefinitionInfo) => void;
  onAttachPersistent: (agentId: string, def: AgentDefinitionInfo) => void;
  onStopPersistent: (agentId: string, def: AgentDefinitionInfo) => void;
}

function AgentFolderNode({
  agentId,
  folder,
  allFolders,
  allDefinitions,
  depth,
  selectedDefIds,
  allSelectedDefIds,
  onOpenDefinition,
  onNewConnection,
  onEditDefinition,
  onDuplicateDefinition,
  onDefinitionClick,
  onStartPersistent,
  onAttachPersistent,
  onStopPersistent,
  filter,
  activeIndex,
  getNodeIndex,
  getRowRef,
  onTreeKeyDown,
  onRowFocus,
  onToggleFolder,
}: AgentFolderNodeProps) {
  const createAgentFolder = useAppStore((s) => s.createAgentFolder);
  const deleteAgentFolder = useAppStore((s) => s.deleteAgentFolder);

  const [creatingSubfolder, setCreatingSubfolder] = useState(false);

  // Under an active filter, matched folders are force-expanded regardless of
  // their stored state (auto-expand matches).
  const expanded = filter ? filter.visibleFolderIds.has(folder.id) : folder.isExpanded;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  const childFolders = useMemo(
    () => allFolders.filter((f) => f.parentId === folder.id),
    [allFolders, folder.id]
  );
  const childDefinitions = useMemo(
    () => allDefinitions.filter((d) => d.folderId === folder.id),
    [allDefinitions, folder.id]
  );
  const visibleChildFolders = filter
    ? childFolders.filter((f) => filter.visibleFolderIds.has(f.id))
    : childFolders;
  const visibleChildDefinitions = filter
    ? childDefinitions.filter((d) => filter.matchingDefinitionIds.has(d.id))
    : childDefinitions;

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `agent-folder:${agentId}:${folder.id}`,
    data: { type: "agent-folder", agentId, folderId: folder.id },
  });
  const rowIndex = getNodeIndex(folder.id);
  const rowRef = getRowRef(rowIndex);
  // Merge the droppable ref with the roving-nav row ref so the folder button is
  // both a drop target and a focusable roving-tabindex row.
  const setRowNode = useCallback(
    (el: HTMLButtonElement | null) => {
      setDropRef(el);
      rowRef(el);
    },
    [setDropRef, rowRef]
  );
  const { active } = useDndContext();
  const isAgentConnectionOver =
    isOver &&
    active?.data.current?.type === "agent-connection" &&
    active?.data.current?.agentId === agentId;

  return (
    <div>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            ref={setRowNode}
            className={`connection-tree__folder${isAgentConnectionOver ? " connection-tree__folder--drop-over" : ""}`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => onToggleFolder(folder.id)}
            role="treeitem"
            aria-expanded={expanded}
            aria-level={depth}
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
              onSelect={() => onNewConnection(folder.id)}
            >
              <Plus size={14} />
              New Connection
            </ContextMenu.Item>
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => setCreatingSubfolder(true)}
            >
              <FolderPlus size={14} />
              New Subfolder
            </ContextMenu.Item>
            <ContextMenu.Separator className="context-menu__separator" />
            <ContextMenu.Item
              className="context-menu__item context-menu__item--danger"
              onSelect={() => deleteAgentFolder(agentId, folder.id)}
            >
              <Trash2 size={14} />
              Delete Folder
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
                createAgentFolder(agentId, name, folder.id);
                setCreatingSubfolder(false);
              }}
              onCancel={() => setCreatingSubfolder(false)}
            />
          )}
          {visibleChildFolders.map((f) => (
            <AgentFolderNode
              key={f.id}
              agentId={agentId}
              folder={f}
              allFolders={allFolders}
              allDefinitions={allDefinitions}
              depth={depth + 1}
              selectedDefIds={selectedDefIds}
              allSelectedDefIds={allSelectedDefIds}
              onOpenDefinition={onOpenDefinition}
              onNewConnection={onNewConnection}
              onEditDefinition={onEditDefinition}
              onDuplicateDefinition={onDuplicateDefinition}
              onDefinitionClick={onDefinitionClick}
              onStartPersistent={onStartPersistent}
              onAttachPersistent={onAttachPersistent}
              onStopPersistent={onStopPersistent}
              filter={filter}
              activeIndex={activeIndex}
              getNodeIndex={getNodeIndex}
              getRowRef={getRowRef}
              onTreeKeyDown={onTreeKeyDown}
              onRowFocus={onRowFocus}
              onToggleFolder={onToggleFolder}
            />
          ))}
          {visibleChildDefinitions.map((def) => (
            <AgentConnectionItem
              key={def.id}
              agentId={agentId}
              definition={def}
              depth={depth + 1}
              isSelected={selectedDefIds.has(def.id)}
              selectedDefIds={allSelectedDefIds}
              onOpen={onOpenDefinition}
              onEdit={onEditDefinition}
              onDuplicate={onDuplicateDefinition}
              onConnectionClick={onDefinitionClick}
              onStartPersistent={onStartPersistent}
              onAttachPersistent={onAttachPersistent}
              onStopPersistent={onStopPersistent}
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

// ── Agent root drop zone ────────────────────────────────────────────

interface AgentRootDropZoneProps {
  agentId: string;
  children: ReactNode;
  onAreaClick?: (event: React.MouseEvent) => void;
  /** Accessible label for the tree (the agent name). */
  ariaLabel: string;
  /** Roving-nav keyboard handler is per-row, but the tree owns the ARIA role. */
  onKeyDown?: (event: React.KeyboardEvent) => void;
}

function AgentRootDropZone({
  agentId,
  children,
  onAreaClick,
  ariaLabel,
  onKeyDown,
}: AgentRootDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `agent-root:${agentId}`,
    data: { type: "agent-root", agentId },
  });
  const { active } = useDndContext();
  const isAgentConnectionOver =
    isOver &&
    active?.data.current?.type === "agent-connection" &&
    active?.data.current?.agentId === agentId;

  return (
    <div
      ref={setNodeRef}
      className={`connection-list__tree connection-list__tree--agent${isAgentConnectionOver ? " connection-tree__root-drop--over" : ""}`}
      onClick={onAreaClick}
      onKeyDown={onKeyDown}
      role="tree"
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

// ── Main agent node ─────────────────────────────────────────────────

interface AgentNodeProps {
  agent: RemoteAgentDefinition;
  style?: React.CSSProperties;
  sectionRef?: (el: HTMLDivElement | null) => void;
  /** Active search query for the Remote Agents section (empty = no filter). */
  filterQuery?: string;
}

export function AgentNode({ agent, style, sectionRef, filterQuery = "" }: AgentNodeProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: agent.id,
    data: { type: "agent" },
  });

  const sortableStyle: React.CSSProperties = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const toggleRemoteAgent = useAppStore((s) => s.toggleRemoteAgent);
  const connectRemoteAgent = useAppStore((s) => s.connectRemoteAgent);
  const disconnectRemoteAgent = useAppStore((s) => s.disconnectRemoteAgent);
  const shutdownRemoteAgent = useAppStore((s) => s.shutdownRemoteAgent);
  const deleteRemoteAgent = useAppStore((s) => s.deleteRemoteAgent);
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const requestPassword = useAppStore((s) => s.requestPassword);
  const addTab = useAppStore((s) => s.addTab);
  // This agent's live sessions, saved definitions and folders, sourced from the
  // projected `agents` region when it faithfully mirrors `appStore`, else
  // `appStore` verbatim (#2226 render cut).
  const {
    agentSessions: projectedSessions,
    agentDefinitions: projectedDefinitions,
    agentFolders: projectedFolders,
  } = useProjectedAgents();
  const agentSessions = projectedSessions[agent.id] ?? EMPTY_SESSIONS;
  const agentDefinitions = projectedDefinitions[agent.id] ?? EMPTY_DEFINITIONS;
  const agentFolders = projectedFolders[agent.id] ?? EMPTY_FOLDERS;
  const refreshAgentSessions = useAppStore((s) => s.refreshAgentSessions);
  const createAgentFolder = useAppStore((s) => s.createAgentFolder);
  const openAgentDefinitionEditorTab = useAppStore((s) => s.openAgentDefinitionEditorTab);

  const [connecting, setConnecting] = useState(false);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [connectionError, setConnectionError] = useState<ClassifiedAgentError | null>(null);
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const isConnected = agent.connectionState === "connected";
  const isReconnecting = agent.connectionState === "reconnecting";
  const isConnecting = agent.connectionState === "connecting";
  const isDisconnected = agent.connectionState === "disconnected";
  const Chevron = agent.isExpanded ? ChevronDown : ChevronRight;

  // Agent version + derived update state (visible only; no update triggering yet, #1347).
  // The desktop version is the expected version the agent is checked against,
  // mirroring the Rust `check_version` rule. While the desktop version is still
  // loading, the badge stays hidden ("unknown") rather than flashing incompatible.
  const desktopVersion = useDesktopVersion();
  const agentVersion = agent.capabilities?.agentVersion;
  const agentUpdateState = isConnected
    ? resolveAgentUpdateState(agentVersion, desktopVersion)
    : "unknown";

  // Derived: root-level folders and definitions (no parent/folder)
  const rootFolders = useMemo(
    () => agentFolders.filter((f) => f.parentId === null || f.parentId === undefined),
    [agentFolders]
  );
  const rootDefinitions = useMemo(
    () => agentDefinitions.filter((d) => d.folderId === null || d.folderId === undefined),
    [agentDefinitions]
  );

  const toggleAgentFolder = useAppStore((s) => s.toggleAgentFolder);

  // Live search filter over this agent's saved definitions (auto-expands
  // matching folders). `null` when the query is empty. Sessions are live, not
  // saved entries, so they are never filtered out.
  const filter = useMemo(
    () => filterAgentTree(filterQuery, agentFolders, agentDefinitions),
    [filterQuery, agentFolders, agentDefinitions]
  );

  // Only a connected/reconnecting agent renders its tree, so the roving-nav
  // node list is empty otherwise (keeps activeIndex clamped to nothing).
  const treeActive = isConnected || isReconnecting;

  // Flattened, in-order list of the interactive rows actually rendered — drives
  // both roving-tabindex keyboard navigation and Shift+Click range selection.
  const visibleNodes = useMemo(
    () =>
      treeActive
        ? computeAgentTreeNodes(agentSessions, agentFolders, agentDefinitions, filter)
        : [],
    [treeActive, agentSessions, agentFolders, agentDefinitions, filter]
  );

  const flatVisibleDefIds = useMemo(
    () => visibleNodes.filter((n) => n.kind === "definition").map((n) => n.id),
    [visibleNodes]
  );

  const {
    selectedIds: selectedDefIds,
    handleItemClick: handleDefClick,
    handleAreaClick: handleTreeAreaClick,
    clearSelection: clearDefSelection,
  } = useTreeSelection(flatVisibleDefIds);

  const allSelectedDefIds = useMemo(() => [...selectedDefIds], [selectedDefIds]);

  // Flat-list index lookup by node id so each row can resolve its position in
  // the roving-nav item array (`visibleNodes`) for tabindex and ref wiring.
  const nodeIndexById = useMemo(() => {
    const map = new Map<string, number>();
    visibleNodes.forEach((node, index) => map.set(node.id, index));
    return map;
  }, [visibleNodes]);
  const getNodeIndex = useCallback((id: string) => nodeIndexById.get(id) ?? -1, [nodeIndexById]);

  // Type-ahead label for a node: a session's title, a definition's name, or a
  // folder's name.
  const folderNameById = useMemo(
    () => new Map(agentFolders.map((f) => [f.id, f.name])),
    [agentFolders]
  );
  const getNodeLabel = useCallback(
    (node: AgentVisibleNode) => {
      if (node.kind === "session") return node.session?.title ?? "";
      if (node.kind === "definition") return node.definition?.name ?? "";
      return folderNameById.get(node.id) ?? "";
    },
    [folderNameById]
  );

  const { activeIndex, setActiveIndex, getRowRef, focusRow, makeKeyDownHandler } = useRovingListNav<
    AgentVisibleNode,
    HTMLButtonElement
  >(visibleNodes, getNodeLabel);

  // While a search filter is active, folders are force-expanded by the render
  // logic; suppress toggles so clearing the filter restores the prior state.
  const handleToggleFolder = useCallback(
    (folderId: string) => {
      if (filter) return;
      toggleAgentFolder(agent.id, folderId);
    },
    [filter, toggleAgentFolder, agent.id]
  );

  useDndMonitor({
    onDragEnd(event) {
      if (
        event.active.data.current?.type === "agent-connection" &&
        event.active.data.current?.agentId === agent.id
      ) {
        clearDefSelection();
      }
    },
  });

  const handleConnect = useCallback(async () => {
    if (connecting) return;

    // If the credential store is locked and this agent uses a stored credential,
    // prompt for unlock first and wait — on success the code continues and the
    // credential resolves automatically.
    const proceed = await ensureCredentialStoreUnlocked({
      authMethod: agent.config.authMethod,
      savePassword: agent.config.savePassword,
    });
    if (!proceed) return;

    setConnecting(true);
    try {
      let password: string | undefined;

      const resolution = await resolveConnectionCredential(
        agent.id,
        agent.config.authMethod,
        agent.config.savePassword
      );

      let promptedPassword: string | undefined;

      if (resolution.usedStoredCredential && resolution.password) {
        password = resolution.password;
      } else if (agent.config.authMethod === "password" && !agent.config.password) {
        const result = await requestPassword(agent.config.host, agent.config.username);
        if (!result) {
          setConnecting(false);
          return;
        }
        password = result;
        promptedPassword = result;
      }

      try {
        await connectRemoteAgent(agent.id, password);
        // Persist the entered password if the user opted in via the prompt checkbox
        if (promptedPassword && useAppStore.getState().passwordPromptShouldSave) {
          await storeCredential(agent.id, "password", promptedPassword).catch((err) => {
            frontendLog("agent_node", `Failed to store credential: ${err}`);
          });
        }
      } catch (err) {
        const classified = classifyAgentError(err);
        if (resolution.usedStoredCredential && classified.category === "auth-failure") {
          await removeCredential(agent.id, resolution.credentialType).catch(() => {});
          const retryPassword = await requestPassword(agent.config.host, agent.config.username);
          if (!retryPassword) {
            setConnecting(false);
            return;
          }
          await connectRemoteAgent(agent.id, retryPassword);
          // Persist the retry password if the user opted in
          if (useAppStore.getState().passwordPromptShouldSave) {
            await storeCredential(agent.id, "password", retryPassword).catch((err) => {
              frontendLog("agent_node", `Failed to store credential: ${err}`);
            });
          }
          return;
        }
        throw err;
      }
    } catch (err) {
      const classified = classifyAgentError(err);
      setConnectionError(classified);
      setErrorDialogOpen(true);
    } finally {
      setConnecting(false);
    }
  }, [agent, connectRemoteAgent, requestPassword, connecting]);

  const handleSetupFromError = useCallback(() => {
    setErrorDialogOpen(false);
    setSetupDialogOpen(true);
  }, []);

  const handleForceReconnect = useCallback(async () => {
    await disconnectRemoteAgent(agent.id);
    void handleConnect();
  }, [agent.id, disconnectRemoteAgent, handleConnect]);

  // Disconnect (detach) — drop the transport but leave persistent daemon-backed
  // remote sessions running so they re-list on the next connect (G9, #1237).
  const handleDisconnect = useCallback(() => {
    disconnectRemoteAgent(agent.id);
  }, [agent.id, disconnectRemoteAgent]);

  // Shutdown (stop remote) — stop the remote sessions and disconnect, reporting
  // how many sessions the agent detached/killed as a success toast (G9, #1237).
  // Returns the promise so the async Button surfaces pending/error feedback.
  const handleShutdown = useCallback(async () => {
    const detached = await shutdownRemoteAgent(agent.id);
    toast.success(
      detached > 0
        ? `Agent shut down — ${detached} session${detached === 1 ? "" : "s"} stopped`
        : "Agent shut down"
    );
  }, [agent.id, shutdownRemoteAgent]);

  // Cancel an in-flight connect (G1, #1235). Fires cancel_connect_agent, which
  // aborts the blocking SSH + initialize handshake; the backend then emits
  // `disconnected` (single writer), so the state dot returns on its own — no
  // optimistic write here. The prompt-driven `connecting` local state (set by
  // handleConnect) also clears when connectRemoteAgent's promise rejects.
  const handleCancelConnect = useCallback(async () => {
    try {
      await cancelConnectAgent(agent.id);
      toast.success("Connect cancelled");
    } catch (err) {
      frontendLog("agent_node", `Failed to cancel agent connect: ${err}`);
      toast.error(`Failed to cancel: ${err}`);
    }
  }, [agent.id]);

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
      // If the agent reported which saved-connection definition this session
      // was created from, route through the adopt+attach path so the new tab
      // re-attaches to the existing session (with scrollback replay) instead
      // of spawning a fresh one. Falls back to the simple addTab path for
      // legacy sessions created before the agent learned about definition_id.
      const def = session.definitionId
        ? agentDefinitions.find((d) => d.id === session.definitionId)
        : undefined;
      if (def && session.definitionId) {
        useAppStore
          .getState()
          .adoptAndAttachAgentPersistentSession(agent.id, def, session.sessionId);
        return;
      }
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
    [agent.id, addTab, agentDefinitions]
  );

  const handleOpenDefinition = useCallback(
    (def: AgentDefinitionInfo) => {
      addTab(
        def.name,
        "remote-session",
        {
          type: "remote-session",
          config: {
            agentId: agent.id,
            sessionType: def.sessionType as "shell" | "serial",
            ...(def.config as Record<string, unknown>),
            persistent: def.persistent,
            title: def.name,
            // Link the session to its source definition so reattach can
            // recover the persistent connectionId from listAgentSessions.
            definitionId: def.id,
          },
        },
        { terminalOptions: def.terminalOptions }
      );
    },
    [agent.id, addTab]
  );

  const handleRefresh = useCallback(() => {
    refreshAgentSessions(agent.id);
  }, [agent.id, refreshAgentSessions]);

  const handleNewConnection = useCallback(
    (folderId: string | null = null) => {
      openAgentDefinitionEditorTab(agent.id, "new", folderId);
    },
    [agent.id, openAgentDefinitionEditorTab]
  );

  const handleEditDefinition = useCallback(
    (def: AgentDefinitionInfo) => {
      openAgentDefinitionEditorTab(agent.id, def.id);
    },
    [agent.id, openAgentDefinitionEditorTab]
  );

  const duplicateAgentDef = useAppStore((s) => s.duplicateAgentDef);
  const handleDuplicateDefinition = useCallback(
    (def: AgentDefinitionInfo) => {
      duplicateAgentDef(agent.id, def.id);
    },
    [agent.id, duplicateAgentDef]
  );

  const startAgentPersistentSession = useAppStore((s) => s.startAgentPersistentSession);
  const startAndAttachAgentPersistentSession = useAppStore(
    (s) => s.startAndAttachAgentPersistentSession
  );
  const stopPersistentSession = useAppStore((s) => s.stopPersistentSession);

  const handleStartPersistent = useCallback(
    (_agentId: string, def: AgentDefinitionInfo) => {
      startAgentPersistentSession(agent.id, def);
    },
    [agent.id, startAgentPersistentSession]
  );

  const handleAttachPersistent = useCallback(
    (_agentId: string, def: AgentDefinitionInfo) => {
      // Starts the persistent session first if it is not running yet, so a
      // double-click on a stopped shell turns the sidebar dot green.
      startAndAttachAgentPersistentSession(agent.id, def);
    },
    [agent.id, startAndAttachAgentPersistentSession]
  );

  const handleStopPersistent = useCallback(
    (_agentId: string, def: AgentDefinitionInfo) => {
      stopPersistentSession(`${agent.id}:${def.id}`);
    },
    [agent.id, stopPersistentSession]
  );

  // Activate a row: folders toggle, sessions attach, definitions open — shared
  // by Enter (via the roving-nav handler) and Space (tree-specific handler).
  const activateNode = useCallback(
    (node: AgentVisibleNode) => {
      if (node.kind === "folder") {
        handleToggleFolder(node.id);
      } else if (node.kind === "session" && node.session) {
        handleAttachSession(node.session);
      } else if (node.kind === "definition" && node.definition) {
        // Persistent shells go through the persistent-session machinery so the
        // sidebar dot reflects real state (matching the double-click path).
        if (node.definition.persistent) handleAttachPersistent(agent.id, node.definition);
        else handleOpenDefinition(node.definition);
      }
    },
    [
      handleToggleFolder,
      handleAttachSession,
      handleAttachPersistent,
      handleOpenDefinition,
      agent.id,
    ]
  );

  // Shared roving-nav keydown handler (Up/Down, Home/End, Enter, type-ahead,
  // Escape). Focus navigation does not mutate the multi-selection, so the
  // selection callbacks are intentionally inert (mouse drives selection).
  const rovingKeyDown = useMemo(
    () =>
      makeKeyDownHandler({
        onActivate: activateNode,
        onNavigateUp: () => {},
        onRename: () => {},
        onSelectAll: () => {},
        onClearSelection: clearDefSelection,
        getAnchorIndex: () => -1,
        onSelectRange: () => {},
        onSelectSingle: () => {},
      }),
    [makeKeyDownHandler, activateNode, clearDefSelection]
  );

  // Per-row keydown: tree-specific keys (expand/collapse, move to parent/child,
  // Space to activate) are handled here; everything else delegates to the
  // shared roving-nav handler.
  const handleTreeKeyDown = useCallback(
    (event: React.KeyboardEvent, nodeId: string) => {
      const index = getNodeIndex(nodeId);
      const node = visibleNodes[index];
      if (!node) return;
      switch (event.key) {
        case "ArrowRight": {
          if (node.kind !== "folder") return;
          event.preventDefault();
          if (!node.isExpanded && node.hasChildren) {
            handleToggleFolder(node.id);
          } else if (node.isExpanded) {
            const child = visibleNodes[index + 1];
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
    [visibleNodes, getNodeIndex, focusRow, activateNode, rovingKeyDown, handleToggleFolder]
  );

  // Sync the roving active index when a row gains DOM focus (Tab, click).
  const handleRowFocus = useCallback((index: number) => setActiveIndex(index), [setActiveIndex]);

  // Root-level rows filtered to the active search (folders auto-expand matches).
  const visibleRootFolders = filter
    ? rootFolders.filter((f) => filter.visibleFolderIds.has(f.id))
    : rootFolders;
  const visibleRootDefinitions = filter
    ? rootDefinitions.filter((d) => filter.matchingDefinitionIds.has(d.id))
    : rootDefinitions;
  const hasFilterMatches = visibleRootFolders.length + visibleRootDefinitions.length > 0;

  const treeNav: AgentTreeNavProps = {
    filter,
    activeIndex,
    getNodeIndex,
    getRowRef,
    onTreeKeyDown: handleTreeKeyDown,
    onRowFocus: handleRowFocus,
    onToggleFolder: handleToggleFolder,
  };

  const hasContent =
    agentSessions.length > 0 || agentDefinitions.length > 0 || agentFolders.length > 0;

  const combinedRef = useCallback(
    (el: HTMLDivElement | null) => {
      setSortableRef(el);
      sectionRef?.(el);
    },
    [setSortableRef, sectionRef]
  );

  return (
    <div
      ref={combinedRef}
      className={`connection-list__group${agent.isExpanded ? " connection-list__group--expanded" : ""}`}
      style={sortableStyle}
      data-testid={`agent-node-${agent.id}`}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className="connection-list__group-header connection-list__group-header--agent"
            data-testid={`agent-header-${agent.id}`}
            title={`Remote agent: ${agent.name}`}
            {...attributes}
            {...listeners}
          >
            <button
              className="connection-list__group-toggle"
              onClick={() => toggleRemoteAgent(agent.id)}
            >
              <Chevron size={16} className="connection-tree__chevron" />
              <span
                className={`agent-node__state-dot ${STATE_DOT_CLASSES[agent.connectionState] ?? "agent-node__state-dot--disconnected"}`}
                title={agent.connectionState}
                data-testid={`agent-state-${agent.id}`}
              />
              <Server size={14} />
              <span className="connection-list__group-title">{agent.name}</span>
              <AgentVersionBadge
                version={agentVersion}
                state={agentUpdateState}
                data-testid={`agent-version-badge-${agent.id}`}
              />
            </button>
            {isConnected && (
              <div className="connection-list__group-actions">
                <Tooltip content="New Folder" side="top">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<FolderPlus size={16} />}
                    onClick={() => setCreatingFolder(true)}
                    aria-label="New Folder"
                  />
                </Tooltip>
                <Tooltip content="New Connection" side="top">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Plus size={16} />}
                    onClick={() => handleNewConnection(null)}
                    aria-label="New Connection"
                  />
                </Tooltip>
                {/* Two distinct teardown intents (G9, #1237). Detach keeps the
                    remote sessions running; Shutdown stops them. Both go through
                    the async Button so every action gives pending/error feedback;
                    Shutdown adds a success toast with the stopped-session count. */}
                <Tooltip content="Detach transport — keep persistent remote sessions" side="top">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Unplug size={14} />}
                    onClick={handleDisconnect}
                    aria-label="Disconnect (detach)"
                    data-testid={`agent-disconnect-${agent.id}`}
                  />
                </Tooltip>
                <Tooltip content="Stop remote sessions and disconnect" side="top">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Power size={14} />}
                    onClick={handleShutdown}
                    aria-label="Shutdown (stop remote)"
                    data-testid={`agent-shutdown-${agent.id}`}
                  />
                </Tooltip>
              </div>
            )}
            {isConnecting && (
              // Inline Cancel so a stuck connect is abortable without opening the
              // context menu (G1, #1235).
              <div className="connection-list__group-actions">
                <Tooltip content="Cancel Connect" side="top">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<XCircle size={16} />}
                    onClick={() => void handleCancelConnect()}
                    aria-label="Cancel Connect"
                    data-testid={`agent-cancel-connect-${agent.id}`}
                  />
                </Tooltip>
              </div>
            )}
            {isDisconnected && (
              // First-class Reconnect after a drop / auto-reconnect exhaustion
              // (G3, #1236). The native `title` carries the stored last error so
              // the user learns *why* the agent went down (matching the sidebar
              // tree's title-based hover help); clicking re-runs the normal
              // connect path (disconnected → connecting). The async Button gives
              // pending/success feedback and a toast on failure.
              <div className="connection-list__group-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw size={14} />}
                  onClick={handleConnect}
                  aria-label="Reconnect"
                  title={agent.lastError ?? "Reconnect"}
                  data-testid={`agent-reconnect-${agent.id}`}
                >
                  Reconnect
                </Button>
              </div>
            )}
          </div>
        </ContextMenu.Trigger>

        <ContextMenu.Portal>
          <ContextMenu.Content className="context-menu__content">
            {isConnecting ? (
              // A connecting agent is no longer a dead-end: offer Cancel, which
              // aborts the in-flight handshake (G1, #1235).
              <ContextMenu.Item
                className="context-menu__item"
                onSelect={() => void handleCancelConnect()}
                data-testid="context-agent-cancel-connect"
              >
                <XCircle size={14} />
                Cancel Connect
              </ContextMenu.Item>
            ) : !isConnected && !isReconnecting ? (
              <>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={handleConnect}
                  data-testid="context-agent-connect"
                >
                  <Play size={14} />
                  Connect
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={() => setSetupDialogOpen(true)}
                  data-testid="context-agent-setup"
                >
                  <Upload size={14} />
                  Setup Agent...
                </ContextMenu.Item>
              </>
            ) : (
              <>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={handleDisconnect}
                  data-testid="context-agent-disconnect"
                >
                  <Unplug size={14} />
                  Disconnect (detach)
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={() => void handleShutdown()}
                  data-testid="context-agent-shutdown"
                >
                  <Power size={14} />
                  Shutdown (stop remote)
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={handleRefresh}
                  data-testid="context-agent-refresh"
                >
                  <RefreshCw size={14} />
                  Refresh Sessions
                </ContextMenu.Item>
                <ContextMenu.Separator className="context-menu__separator" />
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={handleNewShellSession}
                  data-testid="context-agent-new-shell"
                >
                  <Terminal size={14} />
                  New Shell Session
                </ContextMenu.Item>
                {(agent.capabilities?.availableSerialPorts?.length ?? 0) > 0 && (
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={handleNewSerialSession}
                    data-testid="context-agent-new-serial"
                  >
                    <Cable size={14} />
                    New Serial Session
                  </ContextMenu.Item>
                )}
                <ContextMenu.Separator className="context-menu__separator" />
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={() => handleNewConnection(null)}
                  data-testid="context-agent-new-connection"
                >
                  <Plus size={14} />
                  New Connection
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={() => setCreatingFolder(true)}
                  data-testid="context-agent-new-folder"
                >
                  <FolderPlus size={14} />
                  New Folder
                </ContextMenu.Item>
              </>
            )}
            <ContextMenu.Separator className="context-menu__separator" />
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => openConnectionEditorTab(agent.id)}
              data-testid="context-agent-edit"
            >
              <Pencil size={14} />
              Edit
            </ContextMenu.Item>
            <ContextMenu.Item
              className="context-menu__item context-menu__item--danger"
              onSelect={() => deleteRemoteAgent(agent.id)}
              data-testid="context-agent-delete"
            >
              <Trash2 size={14} />
              Delete
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {/* Deferred-update banner: only for a connected agent with a staged update
          (the banner self-gates on the store's staged/dismissed state, #1352). */}
      {isConnected && <AgentUpdateBanner agentId={agent.id} agentName={agent.name} />}

      <AgentSetupDialog open={setupDialogOpen} onOpenChange={setSetupDialogOpen} agent={agent} />
      <ConnectionErrorDialog
        open={errorDialogOpen}
        onOpenChange={setErrorDialogOpen}
        error={connectionError}
        onSetupAgent={handleSetupFromError}
        onForceReconnect={handleForceReconnect}
      />

      {agent.isExpanded && (
        <AgentRootDropZone
          agentId={agent.id}
          onAreaClick={handleTreeAreaClick}
          ariaLabel={`${agent.name} connections`}
        >
          {isConnected || isReconnecting ? (
            <>
              {/* Reconnecting banner */}
              {isReconnecting && (
                <div
                  className="agent-node__hint agent-node__hint--reconnecting"
                  style={{ paddingLeft: 24 }}
                >
                  <RefreshCw size={12} />
                  Reconnecting…
                </div>
              )}

              {/* Active sessions section */}
              {agentSessions.length > 0 && (
                <>
                  <div className="agent-node__section-label" style={{ paddingLeft: 24 }}>
                    <Zap size={12} />
                    Active Sessions
                  </div>
                  {agentSessions.map((session) => {
                    const rowIndex = getNodeIndex(session.sessionId);
                    return (
                      <button
                        key={session.sessionId}
                        ref={getRowRef(rowIndex)}
                        className="connection-tree__item"
                        style={{ paddingLeft: 32 }}
                        onDoubleClick={() => handleAttachSession(session)}
                        title={`${session.title} (${session.status})`}
                        role="treeitem"
                        aria-level={1}
                        tabIndex={rowIndex === activeIndex ? 0 : -1}
                        onKeyDown={(e) => handleTreeKeyDown(e, session.sessionId)}
                        onFocus={() => handleRowFocus(rowIndex)}
                      >
                        <SessionTypeIcon type={session.type} />
                        <span className="connection-tree__label">{session.title}</span>
                        <span className="connection-tree__type">{session.status}</span>
                      </button>
                    );
                  })}
                </>
              )}

              {/* Saved connections section label (only when sessions also exist) */}
              {agentSessions.length > 0 &&
                (agentDefinitions.length > 0 || agentFolders.length > 0) && (
                  <div className="agent-node__section-label" style={{ paddingLeft: 24 }}>
                    Saved Connections
                  </div>
                )}

              {/* Inline folder creation at root */}
              {creatingFolder && (
                <InlineFolderInput
                  depth={1}
                  onConfirm={(name) => {
                    createAgentFolder(agent.id, name, null);
                    setCreatingFolder(false);
                  }}
                  onCancel={() => setCreatingFolder(false)}
                />
              )}

              {/* Root folders */}
              {visibleRootFolders.map((folder) => (
                <AgentFolderNode
                  key={folder.id}
                  agentId={agent.id}
                  folder={folder}
                  allFolders={agentFolders}
                  allDefinitions={agentDefinitions}
                  depth={1}
                  selectedDefIds={selectedDefIds}
                  allSelectedDefIds={allSelectedDefIds}
                  onOpenDefinition={handleOpenDefinition}
                  onNewConnection={handleNewConnection}
                  onEditDefinition={handleEditDefinition}
                  onDuplicateDefinition={handleDuplicateDefinition}
                  onDefinitionClick={handleDefClick}
                  onStartPersistent={handleStartPersistent}
                  onAttachPersistent={handleAttachPersistent}
                  onStopPersistent={handleStopPersistent}
                  {...treeNav}
                />
              ))}

              {/* Root connections (no folder) */}
              {visibleRootDefinitions.map((def) => (
                <AgentConnectionItem
                  key={def.id}
                  agentId={agent.id}
                  definition={def}
                  depth={1}
                  isSelected={selectedDefIds.has(def.id)}
                  selectedDefIds={allSelectedDefIds}
                  onOpen={handleOpenDefinition}
                  onEdit={handleEditDefinition}
                  onDuplicate={handleDuplicateDefinition}
                  onConnectionClick={handleDefClick}
                  onStartPersistent={handleStartPersistent}
                  onAttachPersistent={handleAttachPersistent}
                  onStopPersistent={handleStopPersistent}
                  activeIndex={activeIndex}
                  getNodeIndex={getNodeIndex}
                  getRowRef={getRowRef}
                  onTreeKeyDown={handleTreeKeyDown}
                  onRowFocus={handleRowFocus}
                />
              ))}

              {/* No-match state while filtering */}
              {filter && !hasFilterMatches && agentSessions.length === 0 && (
                <p className="agent-node__hint" role="status" style={{ paddingLeft: 32 }}>
                  No connections match “{filter.query}”.
                </p>
              )}

              {/* Empty state */}
              {!hasContent && !filter && (
                <div className="agent-node__hint" style={{ paddingLeft: 32 }}>
                  No sessions. Right-click to create one.
                </div>
              )}
            </>
          ) : (
            <div className="agent-node__hint" style={{ paddingLeft: 32 }}>
              Connect to view sessions
            </div>
          )}
        </AgentRootDropZone>
      )}
    </div>
  );
}
