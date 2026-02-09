import { SshConfig } from "@/types/terminal";

interface SshSettingsProps {
  config: SshConfig;
  onChange: (config: SshConfig) => void;
}

export function SshSettings({ config, onChange }: SshSettingsProps) {
  return (
    <div className="settings-form">
      <label className="settings-form__field">
        <span className="settings-form__label">Host</span>
        <input
          type="text"
          value={config.host}
          onChange={(e) => onChange({ ...config, host: e.target.value })}
          placeholder="192.168.1.100"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Port</span>
        <input
          type="number"
          value={config.port}
          onChange={(e) => onChange({ ...config, port: parseInt(e.target.value) || 22 })}
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Username</span>
        <input
          type="text"
          value={config.username}
          onChange={(e) => onChange({ ...config, username: e.target.value })}
          placeholder="user"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Auth Method</span>
        <select
          value={config.authMethod}
          onChange={(e) => onChange({ ...config, authMethod: e.target.value as "password" | "key" })}
        >
          <option value="password">Password</option>
          <option value="key">SSH Key</option>
        </select>
      </label>
      {config.authMethod === "password" && (
        <label className="settings-form__field">
          <span className="settings-form__label">Password</span>
          <input
            type="password"
            value={config.password ?? ""}
            onChange={(e) => onChange({ ...config, password: e.target.value })}
          />
        </label>
      )}
      {config.authMethod === "key" && (
        <label className="settings-form__field">
          <span className="settings-form__label">Key Path</span>
          <input
            type="text"
            value={config.keyPath ?? ""}
            onChange={(e) => onChange({ ...config, keyPath: e.target.value })}
            placeholder="~/.ssh/id_rsa"
          />
        </label>
      )}
    </div>
  );
}
