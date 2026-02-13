import { useState, useCallback, useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { ConnectionType, ConnectionConfig, LocalShellConfig, SshConfig, TelnetConfig, SerialConfig, TerminalOptions } from "@/types/terminal";
import { ConnectionSettings, SshSettings, SerialSettings, TelnetSettings } from "@/components/Settings";
import { getDefaultShell } from "@/utils/shell-detection";
import "./ConnectionEditor.css";

function getDefaultConfigs(defaultShell: string): Record<ConnectionType, ConnectionConfig> {
  return {
    local: { type: "local", config: { shellType: defaultShell } as LocalShellConfig },
    ssh: { type: "ssh", config: { host: "", port: 22, username: "", authMethod: "password" } },
    telnet: { type: "telnet", config: { host: "", port: 23 } },
    serial: { type: "serial", config: { port: "", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" } },
  };
}

const TYPE_OPTIONS: { value: ConnectionType; label: string }[] = [
  { value: "local", label: "Local Shell" },
  { value: "ssh", label: "SSH" },
  { value: "serial", label: "Serial" },
  { value: "telnet", label: "Telnet" },
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

export function ConnectionEditor() {
  const editingConnectionId = useAppStore((s) => s.editingConnectionId);
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
  const externalSources = useAppStore((s) => s.externalSources);
  const addConnection = useAppStore((s) => s.addConnection);
  const updateConnection = useAppStore((s) => s.updateConnection);
  const addExternalConnection = useAppStore((s) => s.addExternalConnection);
  const updateExternalConnection = useAppStore((s) => s.updateExternalConnection);
  const setEditingConnection = useAppStore((s) => s.setEditingConnection);

  const editingConnectionFolderId = useAppStore((s) => s.editingConnectionFolderId);

  // Determine if editing belongs to an external source
  const extFilePath = editingConnectionId && editingConnectionId !== "new"
    ? externalFilePathFromId(editingConnectionId)
    : (editingConnectionFolderId ? externalFilePathFromId(editingConnectionFolderId) : null);

  const extSource = extFilePath
    ? externalSources.find((s) => s.filePath === extFilePath)
    : null;

  const existingConnection = editingConnectionId !== "new"
    ? (extSource
        ? extSource.connections.find((c) => c.id === editingConnectionId)
        : connections.find((c) => c.id === editingConnectionId))
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

  const handleTypeChange = useCallback((type: ConnectionType) => {
    setConnectionConfig(getDefaultConfigs(defaultShell)[type]);
  }, [defaultShell]);

  const handleSave = useCallback(() => {
    if (!name.trim()) return;

    const opts = terminalOptions.horizontalScrolling ? terminalOptions : undefined;

    if (extFilePath) {
      // Saving to an external source
      const prefix = `ext:${extFilePath}::`;
      if (existingConnection) {
        updateExternalConnection(extFilePath, { ...existingConnection, name, config: connectionConfig, folderId, terminalOptions: opts });
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
      updateConnection({ ...existingConnection, name, config: connectionConfig, folderId, terminalOptions: opts });
    } else {
      addConnection({
        id: `conn-${Date.now()}`,
        name,
        config: connectionConfig,
        folderId,
        terminalOptions: opts,
      });
    }
    setEditingConnection(null);
  }, [name, folderId, connectionConfig, terminalOptions, existingConnection, extFilePath, addConnection, updateConnection, addExternalConnection, updateExternalConnection, setEditingConnection]);

  const handleCancel = useCallback(() => {
    setEditingConnection(null);
  }, [setEditingConnection]);

  if (!editingConnectionId) return null;

  return (
    <div className="connection-editor">
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
          />
        </label>
        <label className="settings-form__field">
          <span className="settings-form__label">Folder</span>
          <select
            value={folderId ?? ""}
            onChange={(e) => setFolderId(e.target.value || null)}
          >
            <option value="">(Root)</option>
            {availableFolders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
        <label className="settings-form__field">
          <span className="settings-form__label">Type</span>
          <select
            value={connectionConfig.type}
            onChange={(e) => handleTypeChange(e.target.value as ConnectionType)}
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
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

        <p className="settings-form__hint">
          Use {"${env:VAR}"} for environment variables, e.g. {"${env:USER}"}
        </p>

        <label className="settings-form__field settings-form__field--checkbox">
          <input
            type="checkbox"
            checked={terminalOptions.horizontalScrolling ?? false}
            onChange={(e) => setTerminalOptions({ ...terminalOptions, horizontalScrolling: e.target.checked })}
          />
          <span className="settings-form__label">Enable horizontal scrolling</span>
        </label>

        <div className="connection-editor__actions">
          <button className="connection-editor__btn connection-editor__btn--secondary" onClick={handleCancel}>
            Cancel
          </button>
          <button className="connection-editor__btn connection-editor__btn--primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
