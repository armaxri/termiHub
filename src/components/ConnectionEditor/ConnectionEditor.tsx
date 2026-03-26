import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { PlugZap, TerminalSquare, Palette } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import {
  ConnectionConfig,
  RemoteAgentConfig,
  ShellType,
  TerminalOptions,
  ConnectionEditorMeta,
} from "@/types/terminal";
import { listAvailableShells } from "@/services/api";
import type { ConnectionTypeInfo } from "@/services/api";
import { SavedConnection, RemoteAgentDefinition } from "@/types/connection";
import { SettingsNav } from "@/components/Settings";
import { ConnectionSettingsForm, AGENT_SCHEMA } from "@/components/DynamicForm";
import {
  buildDefaults,
  findPasswordPromptInfo,
  filterRuntimeOptions,
} from "@/utils/schemaDefaults";
import { useAvailableRuntimes } from "@/hooks/useAvailableRuntimes";
import { ConnectionTerminalSettings } from "./ConnectionTerminalSettings";
import { ConnectionAppearanceSettings } from "./ConnectionAppearanceSettings";
import { findLeafByTab } from "@/utils/panelTree";
import "./ConnectionEditor.css";

type EditorCategory = "connection" | "terminal" | "appearance";

const EDITOR_CATEGORIES = [
  { id: "connection", label: "Connection" },
  { id: "terminal", label: "Terminal" },
  { id: "appearance", label: "Appearance" },
];

/** Agent transport mode: only the SSH connection parameters, no terminal settings. */
const AGENT_TRANSPORT_CATEGORIES = [{ id: "connection", label: "Connection" }];

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
};

const STORAGE_KEY = "termihub-editor-category";

function loadSavedCategory(): EditorCategory {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "connection" || saved === "terminal" || saved === "appearance") {
      return saved;
    }
  } catch {
    // Ignore localStorage errors
  }
  return "connection";
}

/** Check whether any field in TerminalOptions has a non-undefined value. */
function hasTerminalOptions(opts: TerminalOptions): boolean {
  return Object.values(opts).some((v) => v !== undefined);
}

/** Build type options from the registry, plus a "Remote Agent" entry. */
function buildTypeOptions(
  connectionTypes: ConnectionTypeInfo[]
): { value: string; label: string }[] {
  const options = connectionTypes.map((ct) => ({
    value: ct.typeId,
    label: ct.displayName,
  }));
  options.push({ value: "remote", label: "Remote Agent" });
  return options;
}

/** Find schema for a type ID in the connection types registry. */
function findSchema(connectionTypes: ConnectionTypeInfo[], typeId: string) {
  return connectionTypes.find((ct) => ct.typeId === typeId);
}

/** Build default settings for a type, applying app settings defaults. */
function buildTypeDefaults(
  typeInfo: ConnectionTypeInfo | undefined,
  appSettings: { defaultUser?: string; defaultSshKeyPath?: string }
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
  return defaults;
}

interface ConnectionEditorProps {
  tabId: string;
  meta: ConnectionEditorMeta;
  isVisible: boolean;
}

export function ConnectionEditor({ tabId, meta, isVisible }: ConnectionEditorProps) {
  const connections = useAppStore((s) => s.connections);
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
      return {
        typeId: existingAgentDef.sessionType,
        settings: existingAgentDef.config,
      };
    }
    if (isAgentDefinitionMode) {
      const firstType = agentConnectionTypes[0];
      if (firstType) {
        return { typeId: firstType.typeId, settings: buildDefaults(firstType.schema) };
      }
      return { typeId: "shell", settings: {} };
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
    // New local connection defaults to local shell
    const localType = findSchema(connectionTypes, "local");
    const defaults = localType ? buildTypeDefaults(localType, settings) : { shell: defaultShell };
    return { typeId: "local", settings: defaults };
  }, [
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
    existingAgentDef?.name ?? existingConnection?.name ?? existingAgent?.name ?? ""
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

  const [terminalOptions, setTerminalOptions] = useState<TerminalOptions>(
    existingAgentDef?.terminalOptions ?? existingConnection?.terminalOptions ?? {}
  );
  const [icon, setIcon] = useState<string | undefined>(
    existingAgentDef?.icon ?? existingConnection?.icon
  );
  const [sourceFile, setSourceFile] = useState<string | null>(
    existingConnection?.sourceFile ?? null
  );

  /** Check if the trimmed name collides with any connection in the same folder or any agent. */
  const nameError = useMemo((): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const isDuplicate = connections.some(
      (c) =>
        c.name.trim().toLowerCase() === trimmed.toLowerCase() &&
        c.id !== editingConnectionId &&
        c.folderId === folderId
    );
    if (isDuplicate) return "A connection with this name already exists in this folder.";
    const isDuplicateAgent = remoteAgents.some(
      (a) => a.name.trim().toLowerCase() === trimmed.toLowerCase() && a.id !== editingConnectionId
    );
    if (isDuplicateAgent) return "A remote agent with this name already exists.";
    return null;
  }, [name, connections, remoteAgents, editingConnectionId, folderId]);

  // Category navigation
  const [activeCategory, setActiveCategory] = useState<EditorCategory>(loadSavedCategory);
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

  // In agent transport mode (not definition mode), force category to "connection"
  useEffect(() => {
    if (isAgentTransportMode && activeCategory !== "connection") {
      setActiveCategory("connection");
    }
  }, [isAgentTransportMode, activeCategory]);

  const handleCategoryChange = useCallback((category: EditorCategory) => {
    setActiveCategory(category);
    try {
      localStorage.setItem(STORAGE_KEY, category);
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const handleTypeChange = useCallback(
    (typeId: string) => {
      setSelectedType(typeId);
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

    if (isAgentTransportMode) {
      const agentConfig = connSettings as unknown as RemoteAgentConfig;
      if (existingAgent) {
        const updated: RemoteAgentDefinition = { ...existingAgent, name, config: agentConfig };
        updateRemoteAgent(updated);
        return updated;
      } else {
        const newAgent: RemoteAgentDefinition = {
          id: `agent-${Date.now()}`,
          name,
          config: agentConfig,
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
    connSettings,
    selectedType,
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
    addTab("Setup SSH Agent", "local", {
      type: "local",
      config: {
        shell: "powershell" as ShellType,
        initialCommand:
          "Start-Process powershell -Verb RunAs -ArgumentList 'Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent; ssh-add; pause'",
      },
    });
  }, [addTab]);

  const handleSave = useCallback(async () => {
    if (isAgentDefinitionMode) {
      if (await saveAgentDefinition()) {
        closeThisTab();
      }
      return;
    }
    if (saveConnection()) {
      closeThisTab();
    }
  }, [isAgentDefinitionMode, saveAgentDefinition, saveConnection, closeThisTab]);

  const handleSaveAndConnect = useCallback(async () => {
    if (isAgentDefinitionMode && existingAgent) {
      if (!(await saveAgentDefinition())) return;
      addTab(name.trim(), "remote-session", {
        type: "remote-session",
        config: {
          agentId: existingAgent.id,
          sessionType: selectedType,
          shell: (connSettings.shell as string) ?? undefined,
          serialPort: (connSettings.port as string) ?? undefined,
          persistent,
          title: name.trim(),
        },
      });
      closeThisTab();
      return;
    }

    const saved = saveConnection();
    if (!saved || "connectionState" in saved) return;

    let config: ConnectionConfig = saved.config;

    // Use schema to detect if a password prompt is needed
    const schema = isAgentTransportMode ? AGENT_SCHEMA : currentTypeInfo?.schema;
    if (schema) {
      const promptInfo = findPasswordPromptInfo(schema, connSettings);
      if (promptInfo) {
        const host = (connSettings[promptInfo.hostKey] as string) ?? "";
        const username = (connSettings[promptInfo.usernameKey] as string) ?? "";
        const password = await requestPassword(host, username);
        if (password === null) return;
        config = {
          ...config,
          config: { ...config.config, [promptInfo.passwordKey]: password },
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
  ]);

  const handleCancel = useCallback(() => {
    closeThisTab();
  }, [closeThisTab]);

  // Suppress the SSH agent setup handler reference so it can be attached to a button outside the form
  void handleSetupSshAgent;

  const enabledExternalFiles = settings.externalConnectionFiles.filter((f) => f.enabled);

  // Filter Docker runtime options based on what's actually installed
  const { dockerAvailable, podmanAvailable, loading: runtimesLoading } = useAvailableRuntimes();

  const currentSchema = useMemo(() => {
    const base = isAgentTransportMode ? AGENT_SCHEMA : currentTypeInfo?.schema;
    if (!base || selectedType !== "docker" || runtimesLoading) return base;
    return filterRuntimeOptions(base, dockerAvailable, podmanAvailable);
  }, [
    isAgentTransportMode,
    currentTypeInfo?.schema,
    selectedType,
    runtimesLoading,
    dockerAvailable,
    podmanAvailable,
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
    <div className="connection-editor__form">
      <label className="settings-form__field">
        <span className="settings-form__label">Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Connection name"
          autoFocus
          className={nameError ? "settings-form__input--error" : ""}
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
      <label className="settings-form__field">
        <span className="settings-form__label">Type</span>
        <select
          value={selectedType}
          onChange={(e) => handleTypeChange(e.target.value)}
          disabled={
            isAgentTransportMode
              ? !!existingAgent
              : isAgentDefinitionMode
                ? !!existingAgentDef
                : false
          }
          data-testid="connection-editor-type-select"
        >
          {typeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {currentSchema && (
        <ConnectionSettingsForm
          schema={currentSchema}
          settings={connSettings}
          onChange={setConnSettings}
        />
      )}

      {isAgentDefinitionMode && (
        <label className="settings-form__field settings-form__field--checkbox">
          <input
            type="checkbox"
            checked={persistent}
            onChange={(e) => setPersistent(e.target.checked)}
            data-testid="connection-editor-persistent"
          />
          <span className="settings-form__label">Persistent session</span>
        </label>
      )}

      {!isAnyAgentMode && (
        <p className="settings-form__hint">
          Use {"${env:VAR}"} for environment variables, e.g. {"${env:USER}"}
        </p>
      )}

      {!isAnyAgentMode && enabledExternalFiles.length > 0 && (
        <label className="settings-form__field">
          <span className="settings-form__label">Storage File</span>
          <select
            value={sourceFile ?? ""}
            onChange={(e) => setSourceFile(e.target.value || null)}
            data-testid="connection-editor-source-file"
          >
            <option value="">Default (connections.json)</option>
            {enabledExternalFiles.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
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
          : existingAgent
            ? "Edit Remote Agent"
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
        <button
          className="connection-editor__btn connection-editor__btn--secondary"
          onClick={handleCancel}
          data-testid="connection-editor-cancel"
        >
          Cancel
        </button>
        {!isAgentTransportMode && (
          <button
            className="connection-editor__btn connection-editor__btn--primary"
            onClick={handleSaveAndConnect}
            data-testid="connection-editor-save-connect"
          >
            Save &amp; Connect
          </button>
        )}
        <button
          className="connection-editor__btn connection-editor__btn--primary"
          onClick={handleSave}
          data-testid="connection-editor-save"
        >
          Save
        </button>
      </div>
    </div>
  );
}
