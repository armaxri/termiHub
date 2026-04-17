/**
 * Agent folder node in the sidebar.
 *
 * Renders a remote agent as an expandable section with connection state,
 * active sessions, and a folder tree of saved connections (mirroring the
 * local connections experience).
 */

import { useState, useCallback, useMemo } from "react";
import { useSortable } from "@dnd-kit/sortable";
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
} from "lucide-react";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { useAppStore } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";
import { RemoteAgentDefinition } from "@/types/connection";
import {
  AgentSessionInfo,
  AgentDefinitionInfo,
  AgentFolderInfo,
  removeCredential,
  storeCredential,
} from "@/services/api";
import { classifyAgentError, ClassifiedAgentError } from "@/utils/classifyAgentError";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import { AgentSetupDialog } from "./AgentSetupDialog";
import { ConnectionErrorDialog } from "./ConnectionErrorDialog";
import { InlineFolderInput } from "./InlineFolderInput";

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

interface AgentConnectionItemProps {
  agentId: string;
  definition: AgentDefinitionInfo;
  depth: number;
  onOpen: (def: AgentDefinitionInfo) => void;
  onEdit: (def: AgentDefinitionInfo) => void;
  onDuplicate: (def: AgentDefinitionInfo) => void;
}

function AgentConnectionItem({
  agentId,
  definition,
  depth,
  onOpen,
  onEdit,
  onDuplicate,
}: AgentConnectionItemProps) {
  const deleteAgentDef = useAppStore((s) => s.deleteAgentDef);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          className="connection-tree__item"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onDoubleClick={() => onOpen(definition)}
          title={`${definition.name} (${definition.sessionType}${definition.persistent ? ", persistent" : ""})`}
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
          <span className="connection-tree__label">{definition.name}</span>
          <span className="connection-tree__type">{definition.sessionType}</span>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item className="context-menu__item" onSelect={() => onOpen(definition)}>
            <Play size={14} />
            Connect
          </ContextMenu.Item>
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

interface AgentFolderNodeProps {
  agentId: string;
  folder: AgentFolderInfo;
  allFolders: AgentFolderInfo[];
  allDefinitions: AgentDefinitionInfo[];
  depth: number;
  onOpenDefinition: (def: AgentDefinitionInfo) => void;
  onNewConnection: (folderId: string | null) => void;
  onEditDefinition: (def: AgentDefinitionInfo) => void;
  onDuplicateDefinition: (def: AgentDefinitionInfo) => void;
}

function AgentFolderNode({
  agentId,
  folder,
  allFolders,
  allDefinitions,
  depth,
  onOpenDefinition,
  onNewConnection,
  onEditDefinition,
  onDuplicateDefinition,
}: AgentFolderNodeProps) {
  const toggleAgentFolder = useAppStore((s) => s.toggleAgentFolder);
  const createAgentFolder = useAppStore((s) => s.createAgentFolder);
  const deleteAgentFolder = useAppStore((s) => s.deleteAgentFolder);

  const [creatingSubfolder, setCreatingSubfolder] = useState(false);

  const Chevron = folder.isExpanded ? ChevronDown : ChevronRight;

  const childFolders = useMemo(
    () => allFolders.filter((f) => f.parentId === folder.id),
    [allFolders, folder.id]
  );
  const childDefinitions = useMemo(
    () => allDefinitions.filter((d) => d.folderId === folder.id),
    [allDefinitions, folder.id]
  );

  return (
    <div>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            className="connection-tree__folder"
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => toggleAgentFolder(agentId, folder.id)}
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

      {folder.isExpanded && (
        <div className="connection-tree__children">
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
          {childFolders.map((f) => (
            <AgentFolderNode
              key={f.id}
              agentId={agentId}
              folder={f}
              allFolders={allFolders}
              allDefinitions={allDefinitions}
              depth={depth + 1}
              onOpenDefinition={onOpenDefinition}
              onNewConnection={onNewConnection}
              onEditDefinition={onEditDefinition}
              onDuplicateDefinition={onDuplicateDefinition}
            />
          ))}
          {childDefinitions.map((def) => (
            <AgentConnectionItem
              key={def.id}
              agentId={agentId}
              definition={def}
              depth={depth + 1}
              onOpen={onOpenDefinition}
              onEdit={onEditDefinition}
              onDuplicate={onDuplicateDefinition}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main agent node ─────────────────────────────────────────────────

interface AgentNodeProps {
  agent: RemoteAgentDefinition;
  style?: React.CSSProperties;
  sectionRef?: (el: HTMLDivElement | null) => void;
}

export function AgentNode({ agent, style, sectionRef }: AgentNodeProps) {
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
  const deleteRemoteAgent = useAppStore((s) => s.deleteRemoteAgent);
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const requestPassword = useAppStore((s) => s.requestPassword);
  const addTab = useAppStore((s) => s.addTab);
  const agentSessions = useAppStore((s) => s.agentSessions[agent.id]) ?? EMPTY_SESSIONS;
  const agentDefinitions = useAppStore((s) => s.agentDefinitions[agent.id]) ?? EMPTY_DEFINITIONS;
  const agentFolders = useAppStore((s) => s.agentFolders[agent.id]) ?? EMPTY_FOLDERS;
  const refreshAgentSessions = useAppStore((s) => s.refreshAgentSessions);
  const createAgentFolder = useAppStore((s) => s.createAgentFolder);
  const openAgentDefinitionEditorTab = useAppStore((s) => s.openAgentDefinitionEditorTab);

  const [connecting, setConnecting] = useState(false);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [connectionError, setConnectionError] = useState<ClassifiedAgentError | null>(null);
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);

  const isConnected = agent.connectionState === "connected";
  const Chevron = agent.isExpanded ? ChevronDown : ChevronRight;

  // Derived: root-level folders and definitions (no parent/folder)
  const rootFolders = useMemo(
    () => agentFolders.filter((f) => f.parentId === null || f.parentId === undefined),
    [agentFolders]
  );
  const rootDefinitions = useMemo(
    () => agentDefinitions.filter((d) => d.folderId === null || d.folderId === undefined),
    [agentDefinitions]
  );

  const handleConnect = useCallback(async () => {
    if (connecting) return;

    // If the credential store is locked and this agent uses a stored credential,
    // prompt for unlock first and wait — on success the code continues and the
    // credential resolves automatically.
    const needsStoredCredential =
      agent.config.authMethod === "password" ||
      (agent.config.authMethod === "key" && agent.config.savePassword);
    if (needsStoredCredential) {
      const credStatus = useAppStore.getState().credentialStoreStatus;
      if (credStatus?.mode === "master_password" && credStatus?.status === "locked") {
        const unlocked = await useAppStore.getState().requestUnlock();
        if (!unlocked) return;
      }
    }

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
      addTab(
        def.name,
        "remote-session",
        {
          type: "remote-session",
          config: {
            agentId: agent.id,
            sessionType: def.sessionType as "shell" | "serial",
            shell: (def.config as Record<string, unknown>).shell as string | undefined,
            serialPort: (def.config as Record<string, unknown>).port as string | undefined,
            persistent: def.persistent,
            title: def.name,
          },
        },
        undefined,
        undefined,
        def.terminalOptions
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
            className="connection-list__group-header"
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
            </button>
            {isConnected && (
              <div className="connection-list__group-actions">
                <button
                  className="connection-list__add-btn"
                  onClick={() => setCreatingFolder(true)}
                  title="New Folder"
                >
                  <FolderPlus size={16} />
                </button>
                <button
                  className="connection-list__add-btn"
                  onClick={() => handleNewConnection(null)}
                  title="New Connection"
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
                  <Square size={14} />
                  Disconnect
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

      <AgentSetupDialog open={setupDialogOpen} onOpenChange={setSetupDialogOpen} agent={agent} />
      <ConnectionErrorDialog
        open={errorDialogOpen}
        onOpenChange={setErrorDialogOpen}
        error={connectionError}
        onSetupAgent={handleSetupFromError}
      />

      {agent.isExpanded && (
        <div className="connection-list__tree">
          {isConnected ? (
            <>
              {/* Active sessions section */}
              {agentSessions.length > 0 && (
                <>
                  <div className="agent-node__section-label" style={{ paddingLeft: 24 }}>
                    <Zap size={12} />
                    Active Sessions
                  </div>
                  {agentSessions.map((session) => (
                    <button
                      key={session.sessionId}
                      className="connection-tree__item"
                      style={{ paddingLeft: 32 }}
                      onDoubleClick={() => handleAttachSession(session)}
                      title={`${session.title} (${session.status})`}
                    >
                      <SessionTypeIcon type={session.type} />
                      <span className="connection-tree__label">{session.title}</span>
                      <span className="connection-tree__type">{session.status}</span>
                    </button>
                  ))}
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
              {rootFolders.map((folder) => (
                <AgentFolderNode
                  key={folder.id}
                  agentId={agent.id}
                  folder={folder}
                  allFolders={agentFolders}
                  allDefinitions={agentDefinitions}
                  depth={1}
                  onOpenDefinition={handleOpenDefinition}
                  onNewConnection={handleNewConnection}
                  onEditDefinition={handleEditDefinition}
                  onDuplicateDefinition={handleDuplicateDefinition}
                />
              ))}

              {/* Root connections (no folder) */}
              {rootDefinitions.map((def) => (
                <AgentConnectionItem
                  key={def.id}
                  agentId={agent.id}
                  definition={def}
                  depth={1}
                  onOpen={handleOpenDefinition}
                  onEdit={handleEditDefinition}
                  onDuplicate={handleDuplicateDefinition}
                />
              ))}

              {/* Empty state */}
              {!hasContent && (
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
        </div>
      )}
    </div>
  );
}
