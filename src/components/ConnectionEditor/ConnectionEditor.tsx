import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { PlugZap, TerminalSquare, Palette, Settings, KeyRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import {
  ConnectionConfig,
  ExternalAgentFile,
  RemoteAgentConfig,
  ShellType,
  TerminalOptions,
  ConnectionEditorMeta,
} from "@/types/terminal";
import {
  listAvailableShells,
  resolveCredential,
  storeCredential,
  isSshKeyEncrypted,
} from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import type { ConnectionTypeInfo } from "@/services/api";
import {
  SavedConnection,
  RemoteAgentDefinition,
  AgentSettings,
  DEFAULT_AGENT_SETTINGS,
  JumpHostConfig,
} from "@/types/connection";
import { SettingsNav } from "@/components/Settings";
import { Button, Input, Select, Toggle } from "@/components/ui";
import { ConnectionSettingsForm, AGENT_SCHEMA } from "@/components/DynamicForm";
import {
  buildDefaults,
  findPasswordPromptInfo,
  findKeyPassphrasePromptInfo,
  filterRuntimeOptions,
  filterCredentialFields,
} from "@/utils/schemaDefaults";
import { useAvailableRuntimes } from "@/hooks/useAvailableRuntimes";
import { ConnectionTerminalSettings } from "./ConnectionTerminalSettings";
import { ConnectionAppearanceSettings } from "./ConnectionAppearanceSettings";
import { AgentExternalFilesSettings } from "./AgentExternalFilesSettings";
import { JumpHostSection } from "./JumpHostSection";
import { validateProxyJump } from "@/utils/validateProxyJump";
import { sshJumpHostOptions } from "@/utils/jumpHost";
import { AgentSettingsForm } from "./AgentSettingsForm";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import { findLeafByTab } from "@/utils/panelTree";
import { isWindows } from "@/utils/platform";
import "./ConnectionEditor.css";

type EditorCategory = "connection" | "terminal" | "appearance" | "agent";

const EDITOR_CATEGORIES = [
  { id: "connection", label: "Connection" },
  { id: "terminal", label: "Terminal" },
  { id: "appearance", label: "Appearance" },
];

/** Agent transport mode: SSH connection params + agent runtime settings. */
const AGENT_TRANSPORT_CATEGORIES = [
  { id: "connection", label: "Connection" },
  { id: "agent", label: "Agent" },
];

/** Agent definition mode: connection settings + per-session terminal appearance. */
const AGENT_DEF_CATEGORIES = [
  { id: "connection", label: "Connection" },
  { id: "terminal", label: "Terminal" },
  { id: "appearance", label: "Appearance" },
];

const EDITOR_ICONS: Record<EditorCategory, LucideIcon> = {
  connection: PlugZap,
  terminal: TerminalSquare,
  appearance: Palette,
  agent: Settings,
};

/** Check whether any field in TerminalOptions has a non-undefined value. */
function hasTerminalOptions(opts: TerminalOptions): boolean {
  return Object.values(opts).some((v) => v !== undefined);
}

/** Build type options from the registry. */
function buildTypeOptions(
  connectionTypes: ConnectionTypeInfo[]
): { value: string; label: string }[] {
  return connectionTypes.map((ct) => ({ value: ct.typeId, label: ct.displayName }));
}

/** Find schema for a type ID in the connection types registry. */
function findSchema(connectionTypes: ConnectionTypeInfo[], typeId: string) {
  return connectionTypes.find((ct) => ct.typeId === typeId);
}

/** Normalize legacy session-type aliases to the canonical registry ID. */
function normalizeAgentTypeId(typeId: string, types: ConnectionTypeInfo[]): string {
  if (types.some((ct) => ct.typeId === typeId)) return typeId;
  const aliases: Record<string, string> = { shell: "local" };
  return aliases[typeId] ?? typeId;
}

/** Build default settings for a type, applying app settings defaults. */
function buildTypeDefaults(
  typeInfo: ConnectionTypeInfo | undefined,
  appSettings: {
    defaultUser?: string;
    defaultSshKeyPath?: string;
    defaultShellIntegration?: boolean;
    defaultX11Forwarding?: boolean;
  }
): Record<string, unknown> {
  if (!typeInfo) return {};
  const defaults = buildDefaults(typeInfo.schema);

  // Apply app-level SSH defaults for types that have these fields
  if (appSettings.defaultUser && defaults.username === undefined) {
    // Check if schema has a username field
    for (const group of typeInfo.schema.groups) {
      if (group.fields.some((f) => f.key === "username")) {
        defaults.username = appSettings.defaultUser;
        break;
      }
    }
  }
  if (appSettings.defaultSshKeyPath) {
    for (const group of typeInfo.schema.groups) {
      if (group.fields.some((f) => f.key === "keyPath")) {
        defaults.keyPath = appSettings.defaultSshKeyPath;
        if (defaults.authMethod === "password") {
          defaults.authMethod = "key";
        }
        break;
      }
    }
  }
  for (const group of typeInfo.schema.groups) {
    if (group.fields.some((f) => f.key === "shellIntegration")) {
      defaults.shellIntegration = appSettings.defaultShellIntegration ?? true;
      break;
    }
  }
  for (const group of typeInfo.schema.groups) {
    if (group.fields.some((f) => f.key === "enableX11Forwarding")) {
      defaults.enableX11Forwarding = appSettings.defaultX11Forwarding ?? true;
      break;
    }
  }
  return defaults;
}

interface ConnectionEditorProps {
  tabId: string;
  meta: ConnectionEditorMeta;
  isVisible: boolean;
}

export function ConnectionEditor({ tabId, meta, isVisible }: ConnectionEditorProps) {
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
  const connectionTypes = useAppStore((s) => s.connectionTypes);
  const addConnection = useAppStore((s) => s.addConnection);
  const updateConnection = useAppStore((s) => s.updateConnection);
  const moveConnectionToFile = useAppStore((s) => s.moveConnectionToFile);
  const closeTab = useAppStore((s) => s.closeTab);
  const addTab = useAppStore((s) => s.addTab);
  const requestPassword = useAppStore((s) => s.requestPassword);
  const rootPanel = useAppStore((s) => s.rootPanel);
  const remoteAgents = useAppStore((s) => s.remoteAgents);
  const addRemoteAgent = useAppStore((s) => s.addRemoteAgent);
  const updateRemoteAgent = useAppStore((s) => s.updateRemoteAgent);
  const agentDefinitions = useAppStore((s) => s.agentDefinitions);
  const saveAgentDef = useAppStore((s) => s.saveAgentDef);
  const updateAgentDef = useAppStore((s) => s.updateAgentDef);
  const settings = useAppStore((s) => s.settings);
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);
  const setEditorDirty = useAppStore((s) => s.setEditorDirty);
  const pendingCloseRequest = useAppStore((s) => s.pendingCloseRequest);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);

  const editingConnectionId = meta.connectionId;
  const editingConnectionFolderId = meta.folderId;

  const existingConnection =
    editingConnectionId !== "new"
      ? connections.find((c) => c.id === editingConnectionId)
      : undefined;

  const existingAgent =
    editingConnectionId && editingConnectionId !== "new"
      ? remoteAgents.find((a) => a.id === editingConnectionId)
      : undefined;

  // Resolve agent definition when editing one
  const existingAgentDef = useMemo(() => {
    if (!meta.agentDefinitionId || meta.agentDefinitionId === "new" || !existingAgent)
      return undefined;
    const defs = agentDefinitions[existingAgent.id] ?? [];
    return defs.find((d) => d.id === meta.agentDefinitionId);
  }, [meta.agentDefinitionId, existingAgent, agentDefinitions]);

  /** Agent definition mode: editing/creating a session definition on a connected agent. */
  const isAgentDefinitionMode = !!meta.agentDefinitionId && !!existingAgent;

  // In definition mode, use the agent's own type registry
  const agentConnectionTypes = useMemo(
    () => existingAgent?.capabilities?.connectionTypes ?? [],
    [existingAgent?.capabilities?.connectionTypes]
  );
  const effectiveRegistry = isAgentDefinitionMode ? agentConnectionTypes : connectionTypes;

  const defaultShell = useAppStore((s) => s.defaultShell);

  // Derive initial typeId and settings from existing connection or defaults
  const initialTypeAndSettings = useMemo(() => {
    // Agent definition: existing or new
    if (existingAgentDef) {
      const typeId = normalizeAgentTypeId(existingAgentDef.sessionType, agentConnectionTypes);
      const typeInfo = agentConnectionTypes.find((ct) => ct.typeId === typeId);
      return {
        typeId,
        settings: Object.keys(existingAgentDef.config as Record<string, unknown>).length
          ? (existingAgentDef.config as Record<string, unknown>)
          : typeInfo
            ? buildDefaults(typeInfo.schema)
            : {},
      };
    }
    if (isAgentDefinitionMode) {
      const firstType = agentConnectionTypes[0];
      if (firstType) {
        return { typeId: firstType.typeId, settings: buildDefaults(firstType.schema) };
      }
      return { typeId: "", settings: {} };
    }
    // Agent transport
    if (existingAgent && !meta.agentDefinitionId) {
      return {
        typeId: "remote",
        settings: existingAgent.config as unknown as Record<string, unknown>,
      };
    }
    // Local connection
    if (existingConnection) {
      return {
        typeId: existingConnection.config.type,
        settings: existingConnection.config.config,
      };
    }
    // New remote agent opened via Remote Agents "+" button
    if (editingConnectionId === "new-remote-agent") {
      return { typeId: "remote", settings: buildDefaults(AGENT_SCHEMA) };
    }
    // New local connection defaults to local shell
    const localType = findSchema(connectionTypes, "local");
    const defaults = localType ? buildTypeDefaults(localType, settings) : { shell: defaultShell };
    return { typeId: "local", settings: defaults };
  }, [
    editingConnectionId,
    existingConnection,
    existingAgent,
    existingAgentDef,
    isAgentDefinitionMode,
    agentConnectionTypes,
    meta.agentDefinitionId,
    connectionTypes,
    settings,
    defaultShell,
  ]);

  const [name, setName] = useState(
    existingAgentDef?.name ??
      existingConnection?.name ??
      (isAgentDefinitionMode ? "" : (existingAgent?.name ?? ""))
  );
  const folderId = existingConnection?.folderId ?? editingConnectionFolderId ?? null;
  const [selectedType, setSelectedType] = useState(initialTypeAndSettings.typeId);
  const [connSettings, setConnSettings] = useState<Record<string, unknown>>(
    initialTypeAndSettings.settings
  );
  const [persistent, setPersistent] = useState(existingAgentDef?.persistent ?? false);

  /** Agent transport mode: editing the SSH config to reach the agent itself. */
  const isAgentTransportMode =
    !isAgentDefinitionMode &&
    (!!existingAgent || (selectedType === "remote" && !existingConnection));
  /** Either agent mode (used for shared behavior like hiding Terminal/Appearance). */
  const isAnyAgentMode = isAgentTransportMode || isAgentDefinitionMode;

  /** Whether the SSH "Jump Host" section applies to the current edit. */
  const showJumpHostSection = selectedType === "ssh" && !isAnyAgentMode;

  /** Whether the SSH "Setup SSH Agent" helper applies (SSH + agent auth). */
  const showSshAgentSetup =
    selectedType === "ssh" && !isAnyAgentMode && connSettings.authMethod === "agent";

  // The schema-driven form only tracks its own fields, so its onChange would drop
  // sibling keys like `proxyJump` (managed by JumpHostSection). Re-merge it.
  const handleSchemaSettingsChange = useCallback((values: Record<string, unknown>) => {
    setConnSettings((prev) =>
      prev.proxyJump !== undefined ? { ...values, proxyJump: prev.proxyJump } : values
    );
  }, []);

  const handleJumpHostChange = useCallback((hops: JumpHostConfig[] | undefined) => {
    setConnSettings((prev) => {
      if (hops && hops.length > 0) return { ...prev, proxyJump: hops };
      const { proxyJump: _omit, ...rest } = prev;
      return rest;
    });
  }, []);

  /** SSH connections offered as saved-connection jump-host hops (#940), labelled
   * by folder path and excluding the connection being edited (no self-reference). */
  const jumpHostOptions = useMemo(
    () =>
      showJumpHostSection ? sshJumpHostOptions(connections, folders, editingConnectionId) : [],
    [showJumpHostSection, connections, folders, editingConnectionId]
  );

  /** Jump-host chain validation (errors block save; warnings are advisory). */
  const jumpHostValidation = useMemo(
    () =>
      showJumpHostSection
        ? validateProxyJump((connSettings.proxyJump as JumpHostConfig[] | undefined) ?? [], {
            connections,
            currentConnectionId: editingConnectionId,
          })
        : { errors: [], warnings: [] },
    [showJumpHostSection, connSettings.proxyJump, connections, editingConnectionId]
  );

  const [agentSettings, setAgentSettings] = useState<AgentSettings>(
    existingAgent?.agentSettings ?? DEFAULT_AGENT_SETTINGS
  );

  const [terminalOptions, setTerminalOptions] = useState<TerminalOptions>(
    existingAgentDef?.terminalOptions ?? existingConnection?.terminalOptions ?? {}
  );
  const [icon, setIcon] = useState<string | undefined>(
    existingAgentDef?.icon ?? existingConnection?.icon
  );
  const [sourceFile, setSourceFile] = useState<string | null>(
    existingConnection?.sourceFile ?? null
  );

  // Snapshot initial field values so we can compare against them to detect changes.
  // Using refs (not state) means the snapshot never triggers a re-render.
  // This approach is robust against React StrictMode's double-effect invocation: the
  // comparison is idempotent, so calling the effect twice with unchanged values still
  // yields isDirty=false.  It also enables "revert to original → clean" behaviour.
  //
  // connSettings normalization: the stored config may omit fields that have schema
  // defaults (e.g. shellIntegration).  The form writes them explicitly on the first
  // change, so a toggle-and-revert cycle would otherwise compare {} vs {field: true}.
  // We pre-merge schema defaults into both the baseline snapshot and each comparison
  // to make the check semantically correct ("same effective value" rather than "same
  // stored bytes").
  const connSettingsSchemaDefaultsRef = useRef<Record<string, unknown> | null>(null);
  if (connSettingsSchemaDefaultsRef.current === null) {
    const schema = isAgentTransportMode
      ? AGENT_SCHEMA
      : effectiveRegistry.find((ct) => ct.typeId === selectedType)?.schema;
    connSettingsSchemaDefaultsRef.current = schema ? buildDefaults(schema) : {};
  }
  const connSettingsSchemaDefaults = connSettingsSchemaDefaultsRef.current!;

  const initialName = useRef(name);
  const initialSelectedType = useRef(selectedType);
  const initialConnSettings = useRef({ ...connSettingsSchemaDefaults, ...connSettings });
  const initialTerminalOptions = useRef(terminalOptions);
  const initialIcon = useRef(icon);
  const initialPersistent = useRef(persistent);
  const initialAgentSettings = useRef(agentSettings);
  const initialSourceFile = useRef(sourceFile);

  useEffect(() => {
    const normalizedConnSettings = {
      ...(connSettingsSchemaDefaultsRef.current ?? {}),
      ...connSettings,
    };
    const isDirty =
      name !== initialName.current ||
      selectedType !== initialSelectedType.current ||
      JSON.stringify(normalizedConnSettings) !== JSON.stringify(initialConnSettings.current) ||
      JSON.stringify(terminalOptions) !== JSON.stringify(initialTerminalOptions.current) ||
      icon !== initialIcon.current ||
      persistent !== initialPersistent.current ||
      JSON.stringify(agentSettings) !== JSON.stringify(initialAgentSettings.current) ||
      sourceFile !== initialSourceFile.current;
    setEditorDirty(tabId, isDirty);
  }, [
    name,
    selectedType,
    connSettings,
    terminalOptions,
    icon,
    persistent,
    agentSettings,
    sourceFile,
    tabId,
    setEditorDirty,
  ]);

  // Connections, remote agents, and per-agent definitions occupy independent
  // namespaces — a connection named "Foo" must not collide with an agent
  // named "Foo". Validate only against peers in the entity being edited.
  const nameError = useMemo((): string | null => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return null;

    if (isAgentDefinitionMode && existingAgent) {
      const siblings = agentDefinitions[existingAgent.id] ?? [];
      const editingDefId = existingAgentDef?.id;
      const clash = siblings.some(
        (d) => d.name.trim().toLowerCase() === trimmed && d.id !== editingDefId
      );
      return clash ? "A definition with this name already exists on this agent." : null;
    }

    if (isAgentTransportMode) {
      const clash = remoteAgents.some(
        (a) => a.name.trim().toLowerCase() === trimmed && a.id !== editingConnectionId
      );
      return clash ? "A remote agent with this name already exists." : null;
    }

    const clash = connections.some(
      (c) =>
        c.name.trim().toLowerCase() === trimmed &&
        c.id !== editingConnectionId &&
        c.folderId === folderId
    );
    return clash ? "A connection with this name already exists in this folder." : null;
  }, [
    name,
    connections,
    remoteAgents,
    agentDefinitions,
    existingAgent,
    existingAgentDef,
    isAgentDefinitionMode,
    isAgentTransportMode,
    editingConnectionId,
    folderId,
  ]);

  // Category navigation
  const [activeCategory, setActiveCategory] = useState<EditorCategory>("connection");
  const [isCompact, setIsCompact] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Build type options from the effective registry
  const typeOptions = useMemo(() => {
    if (isAgentDefinitionMode) {
      // Definition mode: show only agent-reported types (no "Remote Agent" entry)
      return agentConnectionTypes.map((ct) => ({ value: ct.typeId, label: ct.displayName }));
    }
    return buildTypeOptions(connectionTypes);
  }, [isAgentDefinitionMode, agentConnectionTypes, connectionTypes]);

  // Get the current schema from the effective registry
  const currentTypeInfo = useMemo(
    () => findSchema(effectiveRegistry, selectedType),
    [effectiveRegistry, selectedType]
  );

  // Track whether a credential is actually stored for this connection.
  // Prevents the hint from showing when savePassword=true but no credential was ever saved.
  const [credentialExistsInStore, setCredentialExistsInStore] = useState(false);
  const credentialId = existingConnection?.id ?? existingAgentDef?.id ?? existingAgent?.id;
  useEffect(() => {
    if (
      !credentialId ||
      credentialStoreStatus?.mode === "none" ||
      connSettings.savePassword !== true
    ) {
      setCredentialExistsInStore(false);
      return;
    }
    let cancelled = false;
    resolveCredential(credentialId, "password")
      .then((val) => {
        if (!cancelled) setCredentialExistsInStore(val !== null);
      })
      .catch(() => {
        if (!cancelled) setCredentialExistsInStore(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialId, credentialStoreStatus?.mode, connSettings.savePassword]);

  // Show a "Password saved in credential store" hint on empty password fields when editing
  // an existing connection that has savePassword=true, an active credential store, and a
  // credential actually present in the store.
  const credentialSavedHint =
    !!(existingConnection || existingAgent) &&
    credentialStoreStatus?.mode !== "none" &&
    connSettings.savePassword === true &&
    !connSettings.password &&
    credentialExistsInStore;

  // ResizeObserver for compact mode
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsCompact(entry.contentRect.width < 480);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // In agent transport mode, only "connection" and "agent" are valid tabs
  useEffect(() => {
    if (isAgentTransportMode && activeCategory !== "connection" && activeCategory !== "agent") {
      setActiveCategory("connection");
    }
  }, [isAgentTransportMode, activeCategory]);

  const handleCategoryChange = useCallback((category: EditorCategory) => {
    setActiveCategory(category);
  }, []);

  const handleTypeChange = useCallback(
    (typeId: string) => {
      setSelectedType(typeId);
      if (typeId === "remote") {
        // "remote" is not in the registry; seed defaults from AGENT_SCHEMA so
        // required fields like authMethod are present from the start.
        setConnSettings(buildDefaults(AGENT_SCHEMA));
        return;
      }
      const typeInfo = findSchema(effectiveRegistry, typeId);
      const defaults = buildTypeDefaults(typeInfo, settings);
      setConnSettings(defaults);
    },
    [effectiveRegistry, settings]
  );

  const closeThisTab = useCallback(() => {
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf) {
      closeTab(tabId, leaf.id);
    }
  }, [rootPanel, tabId, closeTab]);

  /** Save agent definition to the remote agent. Returns true on success. */
  const saveAgentDefinition = useCallback(async (): Promise<boolean> => {
    if (!name.trim() || !existingAgent) return false;
    try {
      const opts = hasTerminalOptions(terminalOptions) ? terminalOptions : undefined;
      if (existingAgentDef) {
        await updateAgentDef(existingAgent.id, {
          id: existingAgentDef.id,
          name: name.trim(),
          session_type: selectedType,
          config: connSettings,
          persistent,
          terminal_options: opts ?? null,
          icon: icon ?? null,
        });
      } else {
        await saveAgentDef(existingAgent.id, {
          name: name.trim(),
          type: selectedType,
          config: connSettings,
          persistent,
          folder_id: meta.agentFolderId ?? null,
          terminal_options: opts,
          icon,
        });
      }
      return true;
    } catch (err) {
      console.error("Failed to save agent definition:", err);
      return false;
    }
  }, [
    name,
    selectedType,
    connSettings,
    persistent,
    terminalOptions,
    icon,
    existingAgent,
    existingAgentDef,
    meta.agentFolderId,
    saveAgentDef,
    updateAgentDef,
  ]);

  /** Save the connection (or agent transport) and return the saved entry. */
  const saveConnection = useCallback((): SavedConnection | RemoteAgentDefinition | null => {
    if (!name.trim()) return null;
    if (nameError) return null;
    if (jumpHostValidation.errors.length > 0) return null;

    if (isAgentTransportMode) {
      const agentConfig = connSettings as unknown as RemoteAgentConfig;
      if (existingAgent) {
        const updated: RemoteAgentDefinition = {
          ...existingAgent,
          name,
          config: agentConfig,
          agentSettings,
        };
        updateRemoteAgent(updated);
        return updated;
      } else {
        const newAgent: RemoteAgentDefinition = {
          id: `agent-${Date.now()}`,
          name,
          config: agentConfig,
          agentSettings,
          isExpanded: false,
          connectionState: "disconnected",
        };
        addRemoteAgent(newAgent);
        return newAgent;
      }
    }

    const connectionConfig: ConnectionConfig = { type: selectedType, config: connSettings };
    const opts = hasTerminalOptions(terminalOptions) ? terminalOptions : undefined;

    if (existingConnection) {
      const saved: SavedConnection = {
        ...existingConnection,
        name,
        config: connectionConfig,
        folderId,
        terminalOptions: opts,
        icon,
        sourceFile,
      };
      updateConnection(saved);

      // If storage file changed, move connection to the new file
      const originalSource = existingConnection.sourceFile ?? null;
      if (originalSource !== sourceFile) {
        moveConnectionToFile(existingConnection.id, sourceFile);
      }

      return saved;
    } else {
      const saved: SavedConnection = {
        id: `conn-${Date.now()}`,
        name,
        config: connectionConfig,
        folderId,
        terminalOptions: opts,
        icon,
        sourceFile,
      };
      addConnection(saved);
      return saved;
    }
  }, [
    name,
    nameError,
    jumpHostValidation,
    connSettings,
    selectedType,
    agentSettings,
    terminalOptions,
    icon,
    sourceFile,
    existingConnection,
    existingAgent,
    isAgentTransportMode,
    folderId,
    addConnection,
    updateConnection,
    moveConnectionToFile,
    addRemoteAgent,
    updateRemoteAgent,
  ]);

  const handleSetupSshAgent = useCallback(async () => {
    const shells = await listAvailableShells();
    if (shells.length === 0) return;
    if (isWindows()) {
      // Windows' ssh-agent is a service that is disabled by default; enable and
      // start it (elevated), then add the user's keys.
      addTab("Setup SSH Agent", "local", {
        type: "local",
        config: {
          shell: "powershell" as ShellType,
          initialCommand:
            "Start-Process powershell -Verb RunAs -ArgumentList 'Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent; ssh-add; pause'",
        },
      });
      return;
    }
    // macOS / Linux: start an agent for this shell (if none is running) and add
    // the default keys. `ssh-add` alone errors when no agent is reachable.
    addTab("Setup SSH Agent", "local", {
      type: "local",
      config: {
        shell: (shells[0] as ShellType) ?? "bash",
        initialCommand: 'eval "$(ssh-agent -s)" && ssh-add',
      },
    });
  }, [addTab]);

  /** Save without closing. Returns true on success. */
  const handleSaveOnly = useCallback(async (): Promise<boolean> => {
    if (isAgentDefinitionMode) {
      return saveAgentDefinition();
    }
    return saveConnection() !== null;
  }, [isAgentDefinitionMode, saveAgentDefinition, saveConnection]);

  const handleSave = useCallback(async () => {
    if (await handleSaveOnly()) {
      closeThisTab();
    }
  }, [handleSaveOnly, closeThisTab]);

  const handleDialogCancel = useCallback(() => {
    setPendingCloseRequest(null);
  }, [setPendingCloseRequest]);

  const handleDialogJustClose = useCallback(() => {
    setPendingCloseRequest(null);
    closeThisTab();
  }, [setPendingCloseRequest, closeThisTab]);

  const handleDialogSaveAndClose = useCallback(async () => {
    if (await handleSaveOnly()) {
      setPendingCloseRequest(null);
      closeThisTab();
    }
  }, [handleSaveOnly, setPendingCloseRequest, closeThisTab]);

  const handleSaveAndConnect = useCallback(async () => {
    if (isAgentDefinitionMode && existingAgent) {
      if (!(await saveAgentDefinition())) return;
      addTab(
        name.trim(),
        "remote-session",
        {
          type: "remote-session",
          config: {
            agentId: existingAgent.id,
            sessionType: selectedType,
            ...connSettings,
            persistent,
            title: name.trim(),
          },
        },
        undefined,
        undefined,
        terminalOptions
      );
      closeThisTab();
      return;
    }

    const saved = saveConnection();
    if (!saved || "connectionState" in saved) return;

    let config: ConnectionConfig = saved.config;

    // Use schema to detect if a password/passphrase prompt is needed.
    // findPasswordPromptInfo only matches a visible password field (password
    // auth); for key auth the password field is hidden, so a separate check
    // covers passphrase-protected keys (#879).
    const schema = isAgentTransportMode ? AGENT_SCHEMA : currentTypeInfo?.schema;
    if (schema) {
      // For key auth, prompt based on the key's actual encryption rather than
      // the savePassword flag (#885): a passphrase-protected key must be
      // unlocked even when the user didn't opt to save the passphrase, and an
      // unencrypted key must never trigger a spurious prompt. If the file can't
      // be read, default to prompting so an encrypted key never fails silently.
      let keyEncrypted = false;
      if (connSettings.authMethod === "key") {
        keyEncrypted = await isSshKeyEncrypted((connSettings.keyPath as string) ?? "").catch(
          () => true
        );
      }
      const keyPrompt = findKeyPassphrasePromptInfo(schema, connSettings, keyEncrypted);
      const promptInfo = findPasswordPromptInfo(schema, connSettings) ?? keyPrompt;
      const credentialType: "password" | "key_passphrase" = keyPrompt
        ? "key_passphrase"
        : "password";
      if (promptInfo) {
        const host = (connSettings[promptInfo.hostKey] as string) ?? "";
        const username = (connSettings[promptInfo.usernameKey] as string) ?? "";

        // Before prompting, check whether the credential store already has a
        // credential for this connection. This avoids re-entering a password
        // when the user only changed a non-credential field and clicks Save & Connect.
        const authMethod = connSettings.authMethod as string | undefined;
        let resolvedPassword: string | null = null;
        if (authMethod) {
          const savePasswordFlag = connSettings.savePassword as boolean | undefined;
          const resolution = await resolveConnectionCredential(
            saved.id,
            authMethod,
            savePasswordFlag
          );
          if (resolution.usedStoredCredential && resolution.password) {
            resolvedPassword = resolution.password;
          }
        }

        if (!resolvedPassword) {
          resolvedPassword = await requestPassword(host, username);
          if (resolvedPassword === null) return;
          // Persist the freshly-entered secret when the prompt's Save box is
          // checked. The sidebar connect path did this but Save & Connect did not,
          // so "Save password" was silently ignored here (#874, #879). The
          // credential type follows the auth method — "password" for password
          // auth, "key_passphrase" for a passphrase-protected key. Store under the
          // connection's persisted id — a new connection's optimistic conn-<ts> id
          // has been reconciled by now (#863), and the editor enforces unique names
          // per folder, so name + folderId identifies the stored entry.
          if (useAppStore.getState().passwordPromptShouldSave) {
            const storeConn = useAppStore
              .getState()
              .connections.find(
                (c) => c.name === saved.name && (c.folderId ?? null) === (saved.folderId ?? null)
              );
            await storeCredential(
              storeConn?.id ?? saved.id,
              credentialType,
              resolvedPassword
            ).catch((err) =>
              frontendLog("connection_editor", `Failed to store credential: ${err}`)
            );
          }
        }

        config = {
          ...config,
          config: { ...config.config, [promptInfo.passwordKey]: resolvedPassword },
        } as ConnectionConfig;
      }
    }

    addTab(saved.name, saved.config.type, config, undefined, undefined, saved.terminalOptions);
    closeThisTab();
  }, [
    isAgentDefinitionMode,
    isAgentTransportMode,
    existingAgent,
    saveAgentDefinition,
    saveConnection,
    requestPassword,
    addTab,
    closeThisTab,
    currentTypeInfo,
    connSettings,
    name,
    selectedType,
    persistent,
    terminalOptions,
  ]);

  const handleCancel = useCallback(() => {
    closeThisTab();
  }, [closeThisTab]);

  const enabledExternalFiles = settings.externalConnectionFiles.filter((f) => f.enabled);

  // Filter Docker runtime options based on what's actually installed
  const { dockerAvailable, podmanAvailable, loading: runtimesLoading } = useAvailableRuntimes();

  const currentSchema = useMemo(() => {
    const base = isAgentTransportMode ? AGENT_SCHEMA : currentTypeInfo?.schema;
    if (!base) return base;
    let schema = base;
    if (selectedType === "docker" && !runtimesLoading) {
      schema = filterRuntimeOptions(schema, dockerAvailable, podmanAvailable);
    }
    return filterCredentialFields(schema, credentialStoreStatus?.mode);
  }, [
    isAgentTransportMode,
    currentTypeInfo?.schema,
    selectedType,
    runtimesLoading,
    dockerAvailable,
    podmanAvailable,
    credentialStoreStatus?.mode,
  ]);

  // Auto-set the runtime value when only one option remains
  useEffect(() => {
    if (selectedType !== "docker" || runtimesLoading || !currentSchema) return;

    for (const group of currentSchema.groups) {
      for (const field of group.fields) {
        if (field.key !== "runtime" || field.fieldType.type !== "select") continue;
        const options = field.fieldType.options;
        if (options.length === 1 && connSettings.runtime !== options[0].value) {
          setConnSettings((prev) => ({ ...prev, runtime: options[0].value }));
        }
      }
    }
  }, [selectedType, runtimesLoading, currentSchema, connSettings.runtime]);

  const renderConnectionContent = () => (
    <>
      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">General</h3>
        <label className="settings-form__field">
          <span className="settings-form__label">Name</span>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Connection name"
            autoFocus
            error={!!nameError}
            data-testid="connection-editor-name-input"
          />
          {nameError && (
            <p
              className="settings-form__hint settings-form__hint--error"
              data-testid="connection-editor-name-error"
            >
              {nameError}
            </p>
          )}
        </label>
        {!isAgentTransportMode && (
          <label className="settings-form__field">
            <span className="settings-form__label">Type</span>
            <Select
              value={selectedType}
              onChange={handleTypeChange}
              options={typeOptions}
              disabled={isAgentDefinitionMode ? !!existingAgentDef : false}
              aria-label="Type"
              data-testid="connection-editor-type-select"
            />
          </label>
        )}
        {!isAgentTransportMode && (
          <p className="settings-form__hint">
            Use {"${VAR}"} for environment variables, e.g. {"${USER}"}
            {isAgentDefinitionMode && " (resolved on the remote machine)"}
          </p>
        )}
        {!isAnyAgentMode && enabledExternalFiles.length > 0 && (
          <label className="settings-form__field">
            <span className="settings-form__label">Storage File</span>
            <Select
              value={sourceFile ?? ""}
              onChange={(v) => setSourceFile(v || null)}
              options={[
                { value: "", label: "Default (connections.json)" },
                ...enabledExternalFiles.map((f) => ({ value: f.path, label: f.path })),
              ]}
              aria-label="Storage File"
              data-testid="connection-editor-source-file"
            />
          </label>
        )}
      </div>

      {currentSchema && (
        <ConnectionSettingsForm
          schema={currentSchema}
          settings={connSettings}
          onChange={handleSchemaSettingsChange}
          credentialSavedHint={credentialSavedHint}
          availablePorts={
            isAgentDefinitionMode
              ? (existingAgent?.capabilities?.availableSerialPorts ?? [])
              : undefined
          }
        />
      )}

      {showJumpHostSection && (
        <JumpHostSection
          value={connSettings.proxyJump as JumpHostConfig[] | undefined}
          targetHost={connSettings.host as string | undefined}
          onChange={handleJumpHostChange}
          savedConnections={jumpHostOptions}
          errors={jumpHostValidation.errors}
          warnings={jumpHostValidation.warnings}
        />
      )}

      {showSshAgentSetup && (
        <div className="settings-panel__category" data-testid="ssh-agent-setup-section">
          <h3 className="settings-panel__category-title">SSH Agent</h3>
          <Button
            variant="secondary"
            size="sm"
            className="connection-editor__setup-agent-btn"
            icon={<KeyRound size={13} aria-hidden />}
            onClick={handleSetupSshAgent}
            data-testid="ssh-setup-agent"
          >
            Setup SSH Agent
          </Button>
          <p className="settings-form__hint">
            Opens a terminal that starts your SSH agent and adds your keys (<code>ssh-add</code>),
            so agent authentication can find them.
          </p>
        </div>
      )}

      {isAgentDefinitionMode && (
        <div className="settings-panel__category">
          <h3 className="settings-panel__category-title">Session</h3>
          <div className="settings-form__field">
            <span className="settings-form__label">Persistent session</span>
            <Toggle
              checked={persistent}
              onCheckedChange={setPersistent}
              aria-label="Persistent session"
              data-testid="connection-editor-persistent"
            />
            <span className="settings-form__hint">
              Keep the session alive when the tab is closed
            </span>
          </div>
        </div>
      )}

      {isAgentTransportMode && (
        <AgentExternalFilesSettings
          files={(connSettings.externalConnectionFiles as ExternalAgentFile[]) ?? []}
          onChange={(files) =>
            setConnSettings((prev) => ({ ...prev, externalConnectionFiles: files }))
          }
        />
      )}
    </>
  );

  const renderContent = () => {
    switch (activeCategory) {
      case "connection":
        return renderConnectionContent();
      case "terminal":
        return (
          <ConnectionTerminalSettings options={terminalOptions} onChange={setTerminalOptions} />
        );
      case "appearance":
        return (
          <ConnectionAppearanceSettings
            color={terminalOptions.color}
            onColorChange={(color) => setTerminalOptions({ ...terminalOptions, color })}
            icon={icon}
            onIconChange={setIcon}
          />
        );
      case "agent":
        return (
          <AgentSettingsForm
            settings={agentSettings}
            onChange={setAgentSettings}
            capabilities={existingAgent?.capabilities}
          />
        );
    }
  };

  const categories = isAgentTransportMode
    ? AGENT_TRANSPORT_CATEGORIES
    : isAgentDefinitionMode
      ? AGENT_DEF_CATEGORIES
      : EDITOR_CATEGORIES;

  return (
    <div
      ref={containerRef}
      className="connection-editor"
      style={{ display: isVisible ? undefined : "none" }}
    >
      <div className="connection-editor__header">
        {isAgentDefinitionMode
          ? existingAgentDef
            ? "Edit Agent Connection"
            : "New Agent Connection"
          : isAgentTransportMode
            ? existingAgent
              ? "Edit Remote Agent"
              : "New Remote Agent"
            : existingConnection
              ? "Edit Connection"
              : "New Connection"}
      </div>
      <div
        className={`connection-editor__body ${isCompact ? "connection-editor__body--compact" : ""}`}
      >
        <SettingsNav
          categories={categories}
          iconMap={EDITOR_ICONS}
          activeCategory={activeCategory}
          onCategoryChange={handleCategoryChange}
          isCompact={isCompact}
        />
        <div className="connection-editor__content">{renderContent()}</div>
      </div>
      <div className="connection-editor__actions">
        <Button variant="secondary" onClick={handleCancel} data-testid="connection-editor-cancel">
          Cancel
        </Button>
        {!isAgentTransportMode && (
          <Button
            variant="primary"
            onClick={handleSaveAndConnect}
            data-testid="connection-editor-save-connect"
          >
            Save &amp; Connect
          </Button>
        )}
        <Button variant="primary" onClick={handleSave} data-testid="connection-editor-save">
          Save
        </Button>
      </div>
      <UnsavedChangesDialog
        open={pendingCloseRequest?.tabId === tabId}
        onCancel={handleDialogCancel}
        onJustClose={handleDialogJustClose}
        onSaveAndClose={handleDialogSaveAndClose}
      />
    </div>
  );
}
