import { useState, useCallback } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import {
  ConnectionType,
  ConnectionConfig,
  LocalShellConfig,
  SshConfig,
  TelnetConfig,
  SerialConfig,
  DockerConfig,
  RemoteAgentConfig,
  ShellType,
  TerminalOptions,
  ConnectionEditorMeta,
} from "@/types/terminal";
import { listAvailableShells } from "@/services/api";
import { SavedConnection, RemoteAgentDefinition } from "@/types/connection";
import {
  ConnectionSettings,
  SshSettings,
  SerialSettings,
  TelnetSettings,
  DockerSettings,
  AgentSettings,
} from "@/components/Settings";
import { ColorPickerDialog } from "@/components/Terminal/ColorPickerDialog";
import { IconPickerDialog } from "./IconPickerDialog";
import { IconByName } from "@/utils/connectionIcons";
import { findLeafByTab } from "@/utils/panelTree";
import "./ConnectionEditor.css";

function getDefaultConfigs(
  defaultShell: string
): Partial<Record<ConnectionType, ConnectionConfig>> {
  return {
    local: { type: "local", config: { shellType: defaultShell } as LocalShellConfig },
    ssh: {
      type: "ssh",
      config: {
        host: "",
        port: 22,
        username: "",
        authMethod: "password",
        enableX11Forwarding: false,
      },
    },
    telnet: { type: "telnet", config: { host: "", port: 23 } },
    serial: {
      type: "serial",
      config: {
        port: "",
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      },
    },
    docker: {
      type: "docker",
      config: {
        image: "",
        envVars: [],
        volumes: [],
        removeOnExit: true,
      },
    },
    "remote-session": {
      type: "remote-session",
      config: {
        agentId: "",
        sessionType: "shell",
        persistent: false,
      },
    },
  };
}

const TYPE_OPTIONS: { value: ConnectionType; label: string }[] = [
  { value: "local", label: "Local Shell" },
  { value: "ssh", label: "SSH" },
  { value: "serial", label: "Serial" },
  { value: "telnet", label: "Telnet" },
  { value: "docker", label: "Docker" },
  { value: "remote", label: "Remote Agent" },
];

interface ConnectionEditorProps {
  tabId: string;
  meta: ConnectionEditorMeta;
  isVisible: boolean;
}

export function ConnectionEditor({ tabId, meta, isVisible }: ConnectionEditorProps) {
  const connections = useAppStore((s) => s.connections);
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

  const defaultConfigs = getDefaultConfigs(defaultShell);

  const [name, setName] = useState(existingConnection?.name ?? existingAgent?.name ?? "");
  const folderId = existingConnection?.folderId ?? editingConnectionFolderId ?? null;
  const [selectedType, setSelectedType] = useState<ConnectionType>(
    existingAgent ? "remote" : (existingConnection?.config.type ?? "local")
  );
  const [connectionConfig, setConnectionConfig] = useState<ConnectionConfig>(
    existingConnection?.config ?? defaultConfigs.local!
  );
  const [agentConfig, setAgentConfig] = useState<RemoteAgentConfig>(
    existingAgent?.config ?? { host: "", port: 22, username: "", authMethod: "password" }
  );

  /** Agent mode: editing an existing agent, or creating new with "remote" type selected. */
  const isAgentMode = !!existingAgent || (selectedType === "remote" && !existingConnection);
  const [terminalOptions, setTerminalOptions] = useState<TerminalOptions>(
    existingConnection?.terminalOptions ?? {}
  );
  const [icon, setIcon] = useState<string | undefined>(existingConnection?.icon);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sourceFile, setSourceFile] = useState<string | null>(
    existingConnection?.sourceFile ?? null
  );

  const handleTypeChange = useCallback(
    (type: ConnectionType) => {
      setSelectedType(type);
      const config = getDefaultConfigs(defaultShell)[type];
      if (config) setConnectionConfig(config);
    },
    [defaultShell]
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

    if (isAgentMode) {
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

    const opts =
      terminalOptions.horizontalScrolling || terminalOptions.color ? terminalOptions : undefined;

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
    connectionConfig,
    terminalOptions,
    icon,
    sourceFile,
    existingConnection,
    existingAgent,
    isAgentMode,
    agentConfig,
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
        shellType: "powershell" as ShellType,
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

    let config = saved.config;

    if (config.type === "ssh" && config.config.authMethod === "password") {
      const sshCfg = config.config as SshConfig;
      const password = await requestPassword(sshCfg.host, sshCfg.username);
      if (password === null) return;
      config = { ...config, config: { ...sshCfg, password } };
    }

    addTab(saved.name, saved.config.type, config, undefined, undefined, saved.terminalOptions);
    closeThisTab();
  }, [saveConnection, requestPassword, addTab, closeThisTab]);

  const handleCancel = useCallback(() => {
    closeThisTab();
  }, [closeThisTab]);

  const enabledExternalFiles = settings.externalConnectionFiles.filter((f) => f.enabled);
  const AdvancedChevron = advancedOpen ? ChevronDown : ChevronRight;

  return (
    <div className="connection-editor" style={{ display: isVisible ? undefined : "none" }}>
      <div className="connection-editor__header">
        {existingAgent
          ? "Edit Remote Agent"
          : existingConnection
            ? "Edit Connection"
            : "New Connection"}
      </div>
      <div className="connection-editor__form">
        <label className="settings-form__field">
          <span className="settings-form__label">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Connection name"
            autoFocus
            data-testid="connection-editor-name-input"
          />
        </label>
        <label className="settings-form__field">
          <span className="settings-form__label">Type</span>
          <select
            value={selectedType}
            onChange={(e) => handleTypeChange(e.target.value as ConnectionType)}
            disabled={!!existingAgent}
            data-testid="connection-editor-type-select"
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        {connectionConfig.type === "local" && (
          <ConnectionSettings
            config={connectionConfig.config}
            onChange={(config: LocalShellConfig) => setConnectionConfig({ type: "local", config })}
          />
        )}
        {connectionConfig.type === "ssh" && (
          <SshSettings
            config={connectionConfig.config}
            onChange={(config: SshConfig) => setConnectionConfig({ type: "ssh", config })}
            onSetupAgent={handleSetupSshAgent}
          />
        )}
        {connectionConfig.type === "serial" && (
          <SerialSettings
            config={connectionConfig.config}
            onChange={(config: SerialConfig) => setConnectionConfig({ type: "serial", config })}
          />
        )}
        {connectionConfig.type === "telnet" && (
          <TelnetSettings
            config={connectionConfig.config}
            onChange={(config: TelnetConfig) => setConnectionConfig({ type: "telnet", config })}
          />
        )}
        {connectionConfig.type === "docker" && (
          <DockerSettings
            config={connectionConfig.config}
            onChange={(config: DockerConfig) => setConnectionConfig({ type: "docker", config })}
          />
        )}
        {selectedType === "remote" && (
          <AgentSettings config={agentConfig} onChange={setAgentConfig} />
        )}

        {!isAgentMode && (
          <p className="settings-form__hint">
            Use {"${env:VAR}"} for environment variables, e.g. {"${env:USER}"}
          </p>
        )}

        {!isAgentMode && (
          <>
            <label className="settings-form__field settings-form__field--checkbox">
              <input
                type="checkbox"
                checked={terminalOptions.horizontalScrolling ?? false}
                onChange={(e) =>
                  setTerminalOptions({ ...terminalOptions, horizontalScrolling: e.target.checked })
                }
                data-testid="connection-editor-horizontal-scroll"
              />
              <span className="settings-form__label">Enable horizontal scrolling</span>
            </label>

            <div className="settings-form__field">
              <span className="settings-form__label">Tab Color</span>
              <div className="connection-editor__color-row">
                {terminalOptions.color && (
                  <div
                    className="connection-editor__color-preview"
                    style={{ backgroundColor: terminalOptions.color }}
                  />
                )}
                <button
                  className="connection-editor__btn connection-editor__btn--secondary"
                  type="button"
                  onClick={() => setColorPickerOpen(true)}
                  data-testid="connection-editor-color-picker"
                >
                  {terminalOptions.color ? "Change" : "Set Color"}
                </button>
                {terminalOptions.color && (
                  <button
                    className="connection-editor__btn connection-editor__btn--secondary"
                    type="button"
                    onClick={() => setTerminalOptions({ ...terminalOptions, color: undefined })}
                    data-testid="connection-editor-clear-color"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <div className="settings-form__field">
              <span className="settings-form__label">Icon</span>
              <div className="connection-editor__color-row">
                {icon && <IconByName name={icon} size={18} />}
                <button
                  className="connection-editor__btn connection-editor__btn--secondary"
                  type="button"
                  onClick={() => setIconPickerOpen(true)}
                  data-testid="connection-editor-icon-picker"
                >
                  {icon ? "Change" : "Set Icon"}
                </button>
                {icon && (
                  <button
                    className="connection-editor__btn connection-editor__btn--secondary"
                    type="button"
                    onClick={() => setIcon(undefined)}
                    data-testid="connection-editor-clear-icon"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <ColorPickerDialog
              open={colorPickerOpen}
              onOpenChange={setColorPickerOpen}
              currentColor={terminalOptions.color}
              onColorChange={(color) =>
                setTerminalOptions({ ...terminalOptions, color: color ?? undefined })
              }
            />
            <IconPickerDialog
              open={iconPickerOpen}
              onOpenChange={setIconPickerOpen}
              currentIcon={icon}
              onIconChange={(i) => setIcon(i ?? undefined)}
            />

            {enabledExternalFiles.length > 0 && (
              <div className="connection-editor__advanced">
                <button
                  className="connection-editor__advanced-toggle"
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  data-testid="connection-editor-advanced-toggle"
                >
                  <AdvancedChevron size={16} />
                  <span>Advanced</span>
                </button>
                {advancedOpen && (
                  <div className="connection-editor__advanced-content">
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
                  </div>
                )}
              </div>
            )}
          </>
        )}

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
    </div>
  );
}
