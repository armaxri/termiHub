import { useState, useCallback, useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import {
  ConnectionType,
  ConnectionConfig,
  LocalShellConfig,
  SshConfig,
  TelnetConfig,
  SerialConfig,
  RemoteConfig,
  TerminalOptions,
  ConnectionEditorMeta,
} from "@/types/terminal";
import {
  ConnectionSettings,
  SshSettings,
  SerialSettings,
  TelnetSettings,
  RemoteSettings,
} from "@/components/Settings";
import { ColorPickerDialog } from "@/components/Terminal/ColorPickerDialog";
import { getDefaultShell } from "@/utils/shell-detection";
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
  const folders = useAppStore((s) => s.folders);
  const externalSources = useAppStore((s) => s.externalSources);
  const addConnection = useAppStore((s) => s.addConnection);
  const updateConnection = useAppStore((s) => s.updateConnection);
  const addExternalConnection = useAppStore((s) => s.addExternalConnection);
  const updateExternalConnection = useAppStore((s) => s.updateExternalConnection);
  const closeTab = useAppStore((s) => s.closeTab);
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

  const availableFolders = extSource ? extSource.folders : folders;

  const [defaultShell, setDefaultShell] = useState("bash");
  useEffect(() => {
    getDefaultShell().then(setDefaultShell);
  }, []);

  const defaultConfigs = getDefaultConfigs(defaultShell);

  const [name, setName] = useState(existingConnection?.name ?? "");
  const [folderId, setFolderId] = useState<string | null>(
    existingConnection?.folderId ?? editingConnectionFolderId ?? null
  );
  const [connectionConfig, setConnectionConfig] = useState<ConnectionConfig>(
    existingConnection?.config ?? defaultConfigs.local
  );
  const [terminalOptions, setTerminalOptions] = useState<TerminalOptions>(
    existingConnection?.terminalOptions ?? {}
  );
  const [colorPickerOpen, setColorPickerOpen] = useState(false);

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

  const handleSave = useCallback(() => {
    if (!name.trim()) return;

    const opts =
      terminalOptions.horizontalScrolling || terminalOptions.color ? terminalOptions : undefined;

    if (extFilePath) {
      // Saving to an external source
      const prefix = `ext:${extFilePath}::`;
      if (existingConnection) {
        updateExternalConnection(extFilePath, {
          ...existingConnection,
          name,
          config: connectionConfig,
          folderId,
          terminalOptions: opts,
        });
      } else {
        const rawId = `conn-${Date.now()}`;
        addExternalConnection(extFilePath, {
          id: `${prefix}${rawId}`,
          name,
          config: connectionConfig,
          folderId,
          terminalOptions: opts,
        });
      }
    } else if (existingConnection) {
      updateConnection({
        ...existingConnection,
        name,
        config: connectionConfig,
        folderId,
        terminalOptions: opts,
      });
    } else {
      addConnection({
        id: `conn-${Date.now()}`,
        name,
        config: connectionConfig,
        folderId,
        terminalOptions: opts,
      });
    }
    closeThisTab();
  }, [
    name,
    folderId,
    connectionConfig,
    terminalOptions,
    existingConnection,
    extFilePath,
    addConnection,
    updateConnection,
    addExternalConnection,
    updateExternalConnection,
    closeThisTab,
  ]);

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
          <span className="settings-form__label">Folder</span>
          <select
            value={folderId ?? ""}
            onChange={(e) => setFolderId(e.target.value || null)}
            data-testid="connection-editor-folder-select"
          >
            <option value="">(Root)</option>
            {availableFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
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
        <ColorPickerDialog
          open={colorPickerOpen}
          onOpenChange={setColorPickerOpen}
          currentColor={terminalOptions.color}
          onColorChange={(color) =>
            setTerminalOptions({ ...terminalOptions, color: color ?? undefined })
          }
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
