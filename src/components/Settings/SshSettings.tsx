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
          data-testid="ssh-settings-host-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Port</span>
        <input
          type="number"
          value={config.port}
          onChange={(e) => onChange({ ...config, port: parseInt(e.target.value) || 22 })}
          data-testid="ssh-settings-port-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Username</span>
        <input
          type="text"
          value={config.username}
          onChange={(e) => onChange({ ...config, username: e.target.value })}
          placeholder="user"
          data-testid="ssh-settings-username-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Auth Method</span>
        <select
          value={config.authMethod}
          onChange={(e) =>
            onChange({ ...config, authMethod: e.target.value as "password" | "key" | "agent" })
          }
          data-testid="ssh-settings-auth-method-select"
        >
          <option value="agent">SSH Agent</option>
          <option value="key">SSH Key</option>
          <option value="password">Password</option>
        </select>
      </label>
      {config.authMethod === "agent" && (
        <p className="settings-form__hint">
          Uses keys from your running SSH agent (ssh-agent or Pageant).
        </p>
      )}
      {config.authMethod === "password" && (
        <p className="settings-form__hint">
          You will be prompted for a password each time you connect.
        </p>
      )}
      {config.authMethod === "key" && (
        <>
          <label className="settings-form__field">
            <span className="settings-form__label">Key Path</span>
            <input
              type="text"
              value={config.keyPath ?? ""}
              onChange={(e) => onChange({ ...config, keyPath: e.target.value })}
              placeholder="~/.ssh/id_ed25519"
              data-testid="ssh-settings-key-path-input"
            />
          </label>
          <label className="settings-form__field">
            <span className="settings-form__label">Key Passphrase (optional)</span>
            <input
              type="password"
              value={config.password ?? ""}
              onChange={(e) => onChange({ ...config, password: e.target.value || undefined })}
              placeholder="Leave empty if unencrypted"
              data-testid="ssh-settings-key-passphrase-input"
            />
          </label>
        </>
      )}
      <label className="settings-form__field settings-form__field--checkbox">
        <input
          type="checkbox"
          checked={config.enableX11Forwarding ?? false}
          onChange={(e) => onChange({ ...config, enableX11Forwarding: e.target.checked })}
          data-testid="ssh-settings-x11-checkbox"
        />
        <span className="settings-form__label">Enable X11 Forwarding</span>
      </label>
      <p className="settings-form__hint">
        Forwards remote GUI applications to your local X server (requires XQuartz on macOS).
      </p>
    </div>
  );
}
