import { useState, useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import {
  ConnectionType,
  ConnectionConfig,
  LocalShellConfig,
  SshConfig,
  TelnetConfig,
  SerialConfig,
  RemoteConfig,
  ShellType,
  TerminalOptions,
  ConnectionEditorMeta,
} from "@/types/terminal";
import { listAvailableShells } from "@/services/api";
import { SavedConnection } from "@/types/connection";
import {
  ConnectionSettings,
  SshSettings,
  SerialSettings,
  TelnetSettings,
  RemoteSettings,
} from "@/components/Settings";
import { ColorPickerDialog } from "@/components/Terminal/ColorPickerDialog";
import { IconPickerDialog } from "./IconPickerDialog";
import { IconByName } from "@/utils/connectionIcons";
import { findLeafByTab } from "@/utils/panelTree";
import "./ConnectionEditor.css";

function getDefaultConfigs(defaultShell: string): Record<ConnectionType, ConnectionConfig> {
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
    remote: {
      type: "remote",
      config: {
        host: "",
        port: 22,
        username: "",
        authMethod: "password",
        sessionType: "shell",
      } as RemoteConfig,
    },
  };
}

const TYPE_OPTIONS: { value: ConnectionType; label: string }[] = [
  { value: "local", label: "Local Shell" },
  { value: "ssh", label: "SSH" },
  { value: "serial", label: "Serial" },
  { value: "telnet", label: "Telnet" },
  { value: "remote", label: "Remote Agent" },
];

/**
 * Determine the external file path from a namespaced ID.
 */
function externalFilePathFromId(id: string): string | null {
  if (id.startsWith("ext:")) {
    const rest = id.slice(4);
    const sep = rest.indexOf("::");
    return sep >= 0 ? rest.slice(0, sep) : null;
  }
  if (id.startsWith("ext-root:")) {
    return id.slice(9);
  }
  return null;
}

interface ConnectionEditorProps {
  tabId: string;
  meta: ConnectionEditorMeta;
  isVisible: boolean;
}

export function ConnectionEditor({ tabId, meta, isVisible }: ConnectionEditorProps) {
  const connections = useAppStore((s) => s.connections);
  const externalSources = useAppStore((s) => s.externalSources);
  const addConnection = useAppStore((s) => s.addConnection);
  const updateConnection = useAppStore((s) => s.updateConnection);
  const addExternalConnection = useAppStore((s) => s.addExternalConnection);
  const updateExternalConnection = useAppStore((s) => s.updateExternalConnection);
  const closeTab = useAppStore((s) => s.closeTab);
  const addTab = useAppStore((s) => s.addTab);
  const requestPassword = useAppStore((s) => s.requestPassword);
  const rootPanel = useAppStore((s) => s.rootPanel);

  const editingConnectionId = meta.connectionId;
  const editingConnectionFolderId = meta.folderId;

  // Determine if editing belongs to an external source
  const extFilePath =
    editingConnectionId && editingConnectionId !== "new"
      ? externalFilePathFromId(editingConnectionId)
      : editingConnectionFolderId
        ? externalFilePathFromId(editingConnectionFolderId)
        : null;

  const extSource = extFilePath ? externalSources.find((s) => s.filePath === extFilePath) : null;

  const existingConnection =
    editingConnectionId !== "new"
      ? extSource
        ? extSource.connections.find((c) => c.id === editingConnectionId)
        : connections.find((c) => c.id === editingConnectionId)
      : undefined;

  const defaultShell = useAppStore((s) => s.defaultShell);

  const defaultConfigs = getDefaultConfigs(defaultShell);

  const [name, setName] = useState(existingConnection?.name ?? "");
  const folderId = existingConnection?.folderId ?? editingConnectionFolderId ?? null;
  const [connectionConfig, setConnectionConfig] = useState<ConnectionConfig>(
    existingConnection?.config ?? defaultConfigs.local
  );
  const [terminalOptions, setTerminalOptions] = useState<TerminalOptions>(
    existingConnection?.terminalOptions ?? {}
  );
  const [icon, setIcon] = useState<string | undefined>(existingConnection?.icon);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  const handleTypeChange = useCallback(
    (type: ConnectionType) => {
      setConnectionConfig(getDefaultConfigs(defaultShell)[type]);
    },
    [defaultShell]
  );

  const closeThisTab = useCallback(() => {
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf) {
      closeTab(tabId, leaf.id);
    }
  }, [rootPanel, tabId, closeTab]);

  /** Save the connection and return the saved entry (or null if name is empty). */
  const saveConnection = useCallback((): SavedConnection | null => {
    if (!name.trim()) return null;

    const opts =
      terminalOptions.horizontalScrolling || terminalOptions.color ? terminalOptions : undefined;

    if (extFilePath) {
      const prefix = `ext:${extFilePath}::`;
      if (existingConnection) {
        const saved: SavedConnection = {
          ...existingConnection,
          name,
          config: connectionConfig,
          folderId,
          terminalOptions: opts,
          icon,
        };
        updateExternalConnection(extFilePath, saved);
        return saved;
      } else {
        const saved: SavedConnection = {
          id: `${prefix}conn-${Date.now()}`,
          name,
          config: connectionConfig,
          folderId,
          terminalOptions: opts,
          icon,
        };
        addExternalConnection(extFilePath, saved);
        return saved;
      }
    } else if (existingConnection) {
      const saved: SavedConnection = {
        ...existingConnection,
        name,
        config: connectionConfig,
        folderId,
        terminalOptions: opts,
        icon,
      };
      updateConnection(saved);
      return saved;
    } else {
      const saved: SavedConnection = {
        id: `conn-${Date.now()}`,
        name,
        config: connectionConfig,
        folderId,
        terminalOptions: opts,
        icon,
      };
      addConnection(saved);
      return saved;
    }
  }, [
    name,
    connectionConfig,
    terminalOptions,
    icon,
    existingConnection,
    extFilePath,
    folderId,
    addConnection,
    updateConnection,
    addExternalConnection,
    updateExternalConnection,
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
    if (!saved) return;

    let config = saved.config;

    if (config.type === "ssh" && config.config.authMethod === "password") {
      const sshCfg = config.config as SshConfig;
      const password = await requestPassword(sshCfg.host, sshCfg.username);
      if (password === null) return;
      config = { ...config, config: { ...sshCfg, password } };
    }

    if (config.type === "remote" && config.config.authMethod === "password") {
      const remoteCfg = config.config as RemoteConfig;
      const password = await requestPassword(remoteCfg.host, remoteCfg.username);
      if (password === null) return;
      config = { ...config, config: { ...remoteCfg, password } };
    }

    addTab(saved.name, saved.config.type, config, undefined, undefined, saved.terminalOptions);
    closeThisTab();
  }, [saveConnection, requestPassword, addTab, closeThisTab]);

  const handleCancel = useCallback(() => {
    closeThisTab();
  }, [closeThisTab]);

  return (
    <div className="connection-editor" style={{ display: isVisible ? undefined : "none" }}>
      <div className="connection-editor__header">
        {existingConnection ? "Edit Connection" : "New Connection"}
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
            value={connectionConfig.type}
            onChange={(e) => handleTypeChange(e.target.value as ConnectionType)}
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
        {connectionConfig.type === "remote" && (
          <RemoteSettings
            config={connectionConfig.config}
            onChange={(config: RemoteConfig) => setConnectionConfig({ type: "remote", config })}
          />
        )}

        <p className="settings-form__hint">
          Use {"${env:VAR}"} for environment variables, e.g. {"${env:USER}"}
        </p>

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

        <div className="connection-editor__actions">
          <button
            className="connection-editor__btn connection-editor__btn--secondary"
            onClick={handleCancel}
            data-testid="connection-editor-cancel"
          >
            Cancel
          </button>
          <button
            className="connection-editor__btn connection-editor__btn--primary"
            onClick={handleSaveAndConnect}
            data-testid="connection-editor-save-connect"
          >
            Save &amp; Connect
          </button>
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
