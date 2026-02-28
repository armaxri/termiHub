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
import { buildDefaults, findPasswordPromptInfo } from "@/utils/schemaDefaults";
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

const AGENT_CATEGORIES = [{ id: "connection", label: "Connection" }];

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

  const defaultShell = useAppStore((s) => s.defaultShell);

  // Derive initial typeId and settings from existing connection or defaults
  const initialTypeAndSettings = useMemo(() => {
    if (existingAgent) {
      return {
        typeId: "remote",
        settings: existingAgent.config as unknown as Record<string, unknown>,
      };
    }
    if (existingConnection) {
      return {
        typeId: existingConnection.config.type,
        settings: existingConnection.config.config,
      };
    }
    // New connection defaults to local shell
    const localType = findSchema(connectionTypes, "local");
    const defaults = localType
      ? buildTypeDefaults(localType, settings)
      : { shell: defaultShell };
    return { typeId: "local", settings: defaults };
  }, [existingConnection, existingAgent, connectionTypes, settings, defaultShell]);

  const [name, setName] = useState(existingConnection?.name ?? existingAgent?.name ?? "");
  const folderId = existingConnection?.folderId ?? editingConnectionFolderId ?? null;
  const [selectedType, setSelectedType] = useState(initialTypeAndSettings.typeId);
  const [connSettings, setConnSettings] = useState<Record<string, unknown>>(
    initialTypeAndSettings.settings
  );

  /** Agent mode: editing an existing agent, or creating new with "remote" type selected. */
  const isAgentMode = !!existingAgent || (selectedType === "remote" && !existingConnection);
  const [terminalOptions, setTerminalOptions] = useState<TerminalOptions>(
    existingConnection?.terminalOptions ?? {}
  );
  const [icon, setIcon] = useState<string | undefined>(existingConnection?.icon);
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

  // Build type options from registry
  const typeOptions = useMemo(() => buildTypeOptions(connectionTypes), [connectionTypes]);

  // Get the current schema
  const currentTypeInfo = useMemo(
    () => findSchema(connectionTypes, selectedType),
    [connectionTypes, selectedType]
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

  // In agent mode, force category to "connection"
  useEffect(() => {
    if (isAgentMode && activeCategory !== "connection") {
      setActiveCategory("connection");
    }
  }, [isAgentMode, activeCategory]);

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
      const typeInfo = findSchema(connectionTypes, typeId);
      const defaults = buildTypeDefaults(typeInfo, settings);
      setConnSettings(defaults);
    },
    [connectionTypes, settings]
  );

  const closeThisTab = useCallback(() => {
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf) {
      closeTab(tabId, leaf.id);
    }
  }, [rootPanel, tabId, closeTab]);

  /** Save the connection (or agent) and return the saved entry (or null if name is empty). */
  const saveConnection = useCallback((): SavedConnection | RemoteAgentDefinition | null => {
    if (!name.trim()) return null;
    if (nameError) return null;

    if (isAgentMode) {
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
    isAgentMode,
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

  const handleSave = useCallback(() => {
    if (saveConnection()) {
      closeThisTab();
    }
  }, [saveConnection, closeThisTab]);

  const handleSaveAndConnect = useCallback(async () => {
    const saved = saveConnection();
    if (!saved || "connectionState" in saved) return;

    let config: ConnectionConfig = saved.config;

    // Use schema to detect if a password prompt is needed
    const schema = isAgentMode ? AGENT_SCHEMA : currentTypeInfo?.schema;
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
    saveConnection,
    requestPassword,
    addTab,
    closeThisTab,
    isAgentMode,
    currentTypeInfo,
    connSettings,
  ]);

  const handleCancel = useCallback(() => {
    closeThisTab();
  }, [closeThisTab]);

  // Suppress the SSH agent setup handler reference so it can be attached to a button outside the form
  void handleSetupSshAgent;

  const enabledExternalFiles = settings.externalConnectionFiles.filter((f) => f.enabled);

  const currentSchema = isAgentMode ? AGENT_SCHEMA : currentTypeInfo?.schema;

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
          disabled={!!existingAgent}
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

      {!isAgentMode && (
        <p className="settings-form__hint">
          Use {"${env:VAR}"} for environment variables, e.g. {"${env:USER}"}
        </p>
      )}

      {!isAgentMode && enabledExternalFiles.length > 0 && (
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

  const categories = isAgentMode ? AGENT_CATEGORIES : EDITOR_CATEGORIES;

  return (
    <div
      ref={containerRef}
      className="connection-editor"
      style={{ display: isVisible ? undefined : "none" }}
    >
      <div className="connection-editor__header">
        {existingAgent
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
        {!isAgentMode && (
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
