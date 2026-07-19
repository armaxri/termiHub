import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { PlugZap, TerminalSquare, Palette, Settings, KeyRound, FileDown } from "lucide-react";
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
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import type { ConnectionTypeInfo } from "@/services/api";
import {
  SavedConnection,
  RemoteAgentDefinition,
  AgentSettings,
  DEFAULT_AGENT_SETTINGS,
  JumpHostConfig,
  SshEditorSettings,
  SshConfigImportConnection,
} from "@/types/connection";
import { SettingsNav } from "@/components/Settings";
import { Button, Input, Select, Toggle, toast } from "@/components/ui";
import { ConnectionSettingsForm, AGENT_SCHEMA } from "@/components/DynamicForm";
import {
  buildDefaults,
  findPasswordPromptInfo,
  findKeyPassphrasePromptInfo,
  filterRuntimeOptions,
  filterCredentialFields,
} from "@/utils/schemaDefaults";
import { useAvailableRuntimes } from "@/hooks/useAvailableRuntimes";
import { shouldOfferGitBashSetup } from "@/utils/gitBashSetup";
import { GitBashSetupDialog } from "@/components/OpenConnections/GitBashSetupDialog";
import { ConnectionTerminalSettings } from "./ConnectionTerminalSettings";
import { ConnectionAppearanceSettings } from "./ConnectionAppearanceSettings";
import { AgentExternalFilesSettings } from "./AgentExternalFilesSettings";
import { JumpHostSection } from "./JumpHostSection";
import { SshConnectionImportDialog } from "./SshConnectionImportDialog";
import { validateProxyJump } from "@/utils/validateProxyJump";
import { sshJumpHostOptions } from "@/utils/jumpHost";
import { AgentSettingsForm } from "./AgentSettingsForm";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import { findLeafByTab } from "@/utils/panelTree";
import { useEditorKeyboard } from "@/hooks/useEditorKeyboard";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { buildGatedTypeOptions } from "@/utils/experimentalTypes";
import { isWindows } from "@/utils/platform";
import "./ConnectionEditor.css";

type EditorCategory = "connection" | "terminal" | "appearance" | "agent";

/**
 * Thrown from `handleSaveAndConnect` when the user dismisses a credential prompt
 * (password or store-unlock). The Save & Connect Button suppresses its default
 * error toast (`errorToast={false}`), so this rejection lands the Button back at
 * idle — no false success flash — while the handler surfaces its own recoverable
 * `toast.info`. See #1344.
 */
class PromptCanceledError extends Error {
  constructor() {
    super("Connect canceled by user");
    this.name = "PromptCanceledError";
  }
}

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

/**
 * Sentinel for the "Default (connections.json)" storage-file option. Radix
 * Select reserves the empty string to clear the selection, so an explicit
 * non-empty value is required and mapped back to `null` (the default storage
 * file) at the call site.
 */
const DEFAULT_STORAGE_FILE = "__default__";

interface ConnectionEditorProps {
  tabId: string;
  meta: ConnectionEditorMeta;
  isVisible: boolean;
}

export function ConnectionEditor({ tabId, meta, isVisible }: ConnectionEditorProps) {
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
  const connectionTypes = useAppStore((s) => s.connectionTypes);
  const refreshConnectionTypes = useAppStore((s) => s.refreshConnectionTypes);
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
  const experimental = useExperimentalFeatures();

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

  /** Whether the whole-connection `~/.ssh/config` import applies (#1722). */
  const showSshConfigImport = selectedType === "ssh" && !isAnyAgentMode;

  /** Whether the SSH "Agent Forwarding" toggle applies (same gate as jump hosts). */
  const showAgentForwarding = selectedType === "ssh" && !isAnyAgentMode;

  /** Whether the SSH "Setup SSH Agent" helper applies (SSH + agent auth). */
  const showSshAgentSetup =
    selectedType === "ssh" && !isAnyAgentMode && connSettings.authMethod === "agent";

  // The schema-driven form only tracks its own fields, so its onChange would drop
  // sibling keys the editor manages directly (`proxyJump` from JumpHostSection,
  // `forwardAgent` from the agent-forwarding toggle). Re-merge them.
  const handleSchemaSettingsChange = useCallback((values: Record<string, unknown>) => {
    setConnSettings((prev) => {
      const merged: Record<string, unknown> = { ...values };
      if (prev.proxyJump !== undefined) merged.proxyJump = prev.proxyJump;
      if (prev.forwardAgent !== undefined) merged.forwardAgent = prev.forwardAgent;
      return merged;
    });
  }, []);

  const handleJumpHostChange = useCallback((hops: JumpHostConfig[] | undefined) => {
    setConnSettings((prev) => {
      if (hops && hops.length > 0) return { ...prev, proxyJump: hops };
      const { proxyJump: _omit, ...rest } = prev;
      return rest;
    });
  }, []);

  /** Toggle SSH agent forwarding; omit the key when off so saved JSON stays stable. */
  const handleForwardAgentChange = useCallback((checked: boolean) => {
    setConnSettings((prev) => {
      if (checked) return { ...prev, forwardAgent: true };
      const { forwardAgent: _omit, ...rest } = prev;
      return rest;
    });
  }, []);

  /** Whole-connection import from `~/.ssh/config` (#1722). */
  const [importOpen, setImportOpen] = useState(false);

  /**
   * Populate the editor from an imported `~/.ssh/config` host: name, target
   * host/user/port, auth (`IdentityFile` → key, else agent), and any resolved
   * jump-host chain. The user reviews and edits before saving.
   */
  const handleImportConnection = useCallback((conn: SshConfigImportConnection) => {
    if (conn.name) setName(conn.name);
    setConnSettings((prev) => {
      const { keyPath: _prevKey, proxyJump: _prevChain, ...rest } = prev;
      const next: Record<string, unknown> = {
        ...rest,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        authMethod: conn.authMethod,
      };
      if (conn.authMethod === "key" && conn.keyPath) next.keyPath = conn.keyPath;
      if (conn.proxyJump.length > 0) next.proxyJump = conn.proxyJump;
      return next;
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

  // Client-side validity of the schema-driven connection form (reported upward
  // by ConnectionSettingsForm). Gates Save/Save & Connect while a visible
  // required field is empty or a value is out of range, instead of deferring to
  // a connect-time backend error.
  const [schemaValid, setSchemaValid] = useState(true);
  const [schemaErrors, setSchemaErrors] = useState<Record<string, string>>({});
  const handleFormValidityChange = useCallback((valid: boolean, errors: Record<string, string>) => {
    setSchemaValid(valid);
    setSchemaErrors(errors);
  }, []);

  /** Whether the connection can be saved: named, unique, valid form + jump hosts. */
  const canSave =
    !!name.trim() && !nameError && schemaValid && jumpHostValidation.errors.length === 0;

  // Category navigation
  const [activeCategory, setActiveCategory] = useState<EditorCategory>("connection");
  const [isCompact, setIsCompact] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Build type options from the effective registry, gating experimental
  // (graphical remote-desktop) types behind `experimentalFeaturesEnabled`
  // (#1705). The currently-selected type is always kept so editing an existing
  // experimental connection never loses its selection.
  const typeOptions = useMemo(() => {
    if (isAgentDefinitionMode) {
      // Definition mode: show only agent-reported types (no "Remote Agent" entry)
      return buildGatedTypeOptions(agentConnectionTypes, experimental, selectedType);
    }
    return buildGatedTypeOptions(connectionTypes, experimental, selectedType);
  }, [isAgentDefinitionMode, agentConnectionTypes, connectionTypes, experimental, selectedType]);

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

  /**
   * Direct the user to the first blocking validation error: flag the owning
   * category (all blocking validation — name, schema fields, jump hosts — lives
   * in the Connection tab), then scroll it into view and focus it. Called when
   * Save/Save & Connect is attempted while the form is invalid.
   */
  const focusFirstInvalidField = useCallback(() => {
    setActiveCategory("connection");
    // Defer until the Connection tab content is mounted/visible.
    requestAnimationFrame(() => {
      const root = containerRef.current;
      if (!root) return;
      let selector: string;
      if (!name.trim() || nameError) {
        selector = '[data-testid="connection-editor-name-input"]';
      } else {
        const firstKey = Object.keys(schemaErrors)[0];
        selector = firstKey ? `[data-testid="field-${firstKey}"]` : "";
      }
      const target = selector ? root.querySelector<HTMLElement>(selector) : null;
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.focus();
      }
    });
  }, [name, nameError, schemaErrors]);

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

  /**
   * Save agent definition to the remote agent. Returns true on success.
   * Rejections propagate so the calling async Button surfaces a recoverable
   * error toast instead of the save failing silently.
   */
  const saveAgentDefinition = useCallback(async (): Promise<boolean> => {
    if (!name.trim() || !existingAgent) return false;
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

  /**
   * Save without closing. Returns true on success. On failure the underlying
   * save rejects, which propagates to the calling async Button so it surfaces a
   * recoverable error toast (rather than the save failing silently).
   *
   * Success feedback: regular connections get their success/error toast from the
   * store's async persist (`addConnection`/`updateConnection`), which is the
   * accurate source of truth — so we only toast here for the paths the store
   * leaves silent: agent definitions and remote-agent transport saves.
   */
  const handleSaveOnly = useCallback(async (): Promise<boolean> => {
    if (!canSave) {
      focusFirstInvalidField();
      return false;
    }
    if (isAgentDefinitionMode) {
      const ok = await saveAgentDefinition();
      if (ok) toast.success(`Saved "${name.trim()}"`);
      return ok;
    }
    const ok = saveConnection() !== null;
    if (ok && isAgentTransportMode) {
      toast.success(`Saved "${name.trim()}"`);
    }
    return ok;
  }, [
    canSave,
    focusFirstInvalidField,
    isAgentDefinitionMode,
    isAgentTransportMode,
    saveAgentDefinition,
    saveConnection,
    name,
  ]);

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
    if (!canSave) {
      focusFirstInvalidField();
      return;
    }
    if (isAgentDefinitionMode && existingAgent) {
      try {
        if (!(await saveAgentDefinition())) return;
      } catch (err) {
        // Save & Connect suppresses the Button's default error toast so it can
        // choose the right severity; surface the save failure explicitly here.
        toast.error("Failed to save agent connection", {
          description: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
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
        { terminalOptions }
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
          // Unlock gate (G3, #1144): if the store is a locked master-password
          // store, prompt for unlock first so the saved credential can be read —
          // otherwise resolveCredential returns null and Save & Connect silently
          // falls back to an interactive prompt, ignoring the stored secret. This
          // matches the sidebar/agent/workspace connect paths.
          const proceed = await ensureCredentialStoreUnlocked({
            authMethod,
            savePassword: savePasswordFlag,
          });
          if (!proceed) {
            // The connection was saved; only the connect step was aborted. Surface
            // a recoverable state (rather than silently resolving, which would flash
            // a false success on the Button) and stop here — see #1344.
            toast.info("Connect canceled — your changes were saved.");
            throw new PromptCanceledError();
          }

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
          if (resolvedPassword === null) {
            // Same recoverable-state handling as the unlock gate above (#1344):
            // the save persisted, so inform the user the connect was canceled
            // instead of returning silently into a false success flash.
            toast.info("Connect canceled — your changes were saved.");
            throw new PromptCanceledError();
          }
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

    addTab(saved.name, saved.config.type, config, { terminalOptions: saved.terminalOptions });
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
    canSave,
    focusFirstInvalidField,
  ]);

  const handleCancel = useCallback(() => {
    closeThisTab();
  }, [closeThisTab]);

  // Escape dismisses the editor through the same unsaved-changes guard as the
  // tab close (TabBar): when the form is dirty, open the confirmation dialog via
  // pendingCloseRequest; otherwise close immediately.
  const handleEscapeCancel = useCallback(() => {
    if (useAppStore.getState().editorDirtyTabs[tabId]) {
      const leaf = findLeafByTab(rootPanel, tabId);
      if (leaf) setPendingCloseRequest({ tabId, panelId: leaf.id });
      return;
    }
    closeThisTab();
  }, [tabId, rootPanel, setPendingCloseRequest, closeThisTab]);

  // Enter (from a single-line text field) saves; Escape cancels. Jump-host list
  // inputs are exempt so Enter there doesn't save the whole connection.
  const handleKeyDown = useEditorKeyboard({
    onSubmit: () => void handleSave(),
    onCancel: handleEscapeCancel,
    exemptSelector: '[data-testid="jump-host-section"]',
  });

  // Autofocus (and select any prefilled name when editing) the primary field.
  const nameRef = useAutofocusSelect<HTMLInputElement>();

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

  // Guided Git-for-Windows setup for the local-shell picker (#1692), mirroring
  // the Settings → Default Shell affordance (#1672). The local schema's `shell`
  // select lists the backend-detected shells, so we read the offer directly off
  // those options: on Windows with no Unix shell (bash/Git Bash/WSL) detected we
  // surface a "Git Bash — set up…" entry point beside the picker. Skipped in
  // agent-definition mode, where the schema reflects a remote machine's shells
  // rather than this Windows host's.
  const [gitBashSetupOpen, setGitBashSetupOpen] = useState(false);

  const localShellOptions = useMemo<ShellType[]>(() => {
    if (selectedType !== "local" || !currentSchema) return [];
    for (const group of currentSchema.groups) {
      for (const field of group.fields) {
        if (field.key === "shell" && field.fieldType.type === "select") {
          return field.fieldType.options.map((o) => o.value as ShellType);
        }
      }
    }
    return [];
  }, [selectedType, currentSchema]);

  const offerGitBashSetup =
    selectedType === "local" &&
    !isAgentDefinitionMode &&
    shouldOfferGitBashSetup(isWindows(), localShellOptions);

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
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Connection name"
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
              value={sourceFile ?? DEFAULT_STORAGE_FILE}
              onChange={(v) => setSourceFile(v === DEFAULT_STORAGE_FILE ? null : v)}
              options={[
                { value: DEFAULT_STORAGE_FILE, label: "Default (connections.json)" },
                ...enabledExternalFiles.map((f) => ({ value: f.path, label: f.path })),
              ]}
              aria-label="Storage File"
              data-testid="connection-editor-source-file"
            />
          </label>
        )}
      </div>

      {showSshConfigImport && (
        <div className="settings-panel__category" data-testid="ssh-config-import-section">
          <Button
            variant="secondary"
            size="sm"
            icon={<FileDown size={13} aria-hidden />}
            onClick={() => setImportOpen(true)}
            data-testid="ssh-config-import-connection-open"
          >
            Import from ~/.ssh/config
          </Button>
          <p className="settings-form__hint">
            Fill in the host, user, port, key, and any jump-host chain from a host in your OpenSSH
            client config. You can review and edit everything before saving.
          </p>
          <SshConnectionImportDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            onImport={handleImportConnection}
          />
        </div>
      )}

      {currentSchema && (
        <ConnectionSettingsForm
          schema={currentSchema}
          settings={connSettings}
          onChange={handleSchemaSettingsChange}
          onValidityChange={handleFormValidityChange}
          credentialSavedHint={credentialSavedHint}
          availablePorts={
            isAgentDefinitionMode
              ? (existingAgent?.capabilities?.availableSerialPorts ?? [])
              : undefined
          }
        />
      )}

      {offerGitBashSetup && (
        <div className="settings-panel__category" data-testid="git-bash-setup-section">
          <Button
            variant="secondary"
            size="sm"
            icon={<TerminalSquare size={13} aria-hidden />}
            onClick={() => setGitBashSetupOpen(true)}
            data-testid="connection-editor-git-bash-setup"
          >
            Git Bash — set up…
          </Button>
          <p className="settings-form__hint">
            No Unix shell detected. Install Git for Windows to run bash, grep, curl and ssh from this
            local connection.
          </p>
        </div>
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

      {showAgentForwarding && (
        <div className="settings-panel__category" data-testid="ssh-agent-forwarding-section">
          <h3 className="settings-panel__category-title">SSH Agent Forwarding</h3>
          <div className="settings-form__field">
            <span className="settings-form__label">Forward SSH agent</span>
            <Toggle
              checked={(connSettings as SshEditorSettings).forwardAgent === true}
              onCheckedChange={handleForwardAgentChange}
              aria-label="Forward SSH agent"
              data-testid="connection-editor-forward-agent"
            />
            <span className="settings-form__hint">
              Make your local <code>ssh-agent</code> keys available on the target — and through the
              jump-host chain — so onward SSH from the host works without copying private keys.
            </span>
          </div>
        </div>
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
      onKeyDown={handleKeyDown}
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
            errorToast={false}
            aria-disabled={!canSave}
            data-invalid={!canSave || undefined}
            data-testid="connection-editor-save-connect"
          >
            Save &amp; Connect
          </Button>
        )}
        <Button
          variant="primary"
          onClick={handleSave}
          aria-disabled={!canSave}
          data-invalid={!canSave || undefined}
          data-testid="connection-editor-save"
        >
          Save
        </Button>
      </div>
      <UnsavedChangesDialog
        open={pendingCloseRequest?.tabId === tabId}
        onCancel={handleDialogCancel}
        onJustClose={handleDialogJustClose}
        onSaveAndClose={handleDialogSaveAndClose}
      />

      <GitBashSetupDialog
        open={gitBashSetupOpen}
        onOpenChange={(open) => {
          setGitBashSetupOpen(open);
          // Re-detect on close so a just-installed Git Bash appears in the
          // shell picker without reopening the editor (#1692).
          if (!open) void refreshConnectionTypes();
        }}
        onInstallGuided={() => void refreshConnectionTypes()}
      />
    </div>
  );
}
