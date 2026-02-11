import { useState, useCallback, useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { ConnectionType, ConnectionConfig, LocalShellConfig, SshConfig, TelnetConfig, SerialConfig } from "@/types/terminal";
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

export function ConnectionEditor() {
  const editingConnectionId = useAppStore((s) => s.editingConnectionId);
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
  const addConnection = useAppStore((s) => s.addConnection);
  const updateConnection = useAppStore((s) => s.updateConnection);
  const setEditingConnection = useAppStore((s) => s.setEditingConnection);

  const editingConnectionFolderId = useAppStore((s) => s.editingConnectionFolderId);

  const existingConnection = editingConnectionId !== "new"
    ? connections.find((c) => c.id === editingConnectionId)
    : undefined;

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

  const handleTypeChange = useCallback((type: ConnectionType) => {
    setConnectionConfig(getDefaultConfigs(defaultShell)[type]);
  }, [defaultShell]);

  const handleSave = useCallback(() => {
    if (!name.trim()) return;

    if (existingConnection) {
      updateConnection({ ...existingConnection, name, config: connectionConfig, folderId });
    } else {
      addConnection({
        id: `conn-${Date.now()}`,
        name,
        config: connectionConfig,
        folderId,
      });
    }
    setEditingConnection(null);
  }, [name, folderId, connectionConfig, existingConnection, addConnection, updateConnection, setEditingConnection]);

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
            {folders.map((f) => (
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
