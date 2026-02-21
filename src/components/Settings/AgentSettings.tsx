import { RemoteAgentConfig } from "@/types/terminal";
import { parseHostPort } from "@/utils/parseHostPort";
import { useAppStore } from "@/store/appStore";
import { KeyPathInput } from "./KeyPathInput";

interface AgentSettingsProps {
  config: RemoteAgentConfig;
  onChange: (config: RemoteAgentConfig) => void;
}

/**
 * Settings form for remote agent SSH transport configuration.
 * No session details — just the SSH connection fields.
 */
export function AgentSettings({ config, onChange }: AgentSettingsProps) {
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);
  const credentialStoreAvailable =
    credentialStoreStatus !== null && credentialStoreStatus.mode !== "none";

  return (
    <div className="settings-form">
      <label className="settings-form__field">
        <span className="settings-form__label">Host</span>
        <input
          type="text"
          value={config.host}
          onChange={(e) => onChange({ ...config, host: e.target.value })}
          onBlur={() => {
            const { host, port } = parseHostPort(config.host);
            if (port !== null) {
              onChange({ ...config, host, port });
            }
          }}
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
          placeholder="pi"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Auth Method</span>
        <select
          value={config.authMethod}
          onChange={(e) =>
            onChange({
              ...config,
              authMethod: e.target.value as "password" | "key" | "agent",
            })
          }
        >
          <option value="password">Password</option>
          <option value="key">SSH Key</option>
          <option value="agent">SSH Agent</option>
        </select>
      </label>
      {config.authMethod === "password" && credentialStoreAvailable && (
        <>
          <label
            className="settings-form__field settings-form__field--checkbox"
            data-testid="agent-settings-save-password-label"
          >
            <input
              type="checkbox"
              checked={config.savePassword ?? false}
              onChange={(e) => onChange({ ...config, savePassword: e.target.checked })}
              data-testid="agent-settings-save-password-checkbox"
            />
            <span className="settings-form__label">Save password</span>
          </label>
          <p className="settings-form__hint">
            {credentialStoreStatus?.mode === "keychain"
              ? "Password will be stored in the OS keychain."
              : "Password will be encrypted with your master password."}
          </p>
        </>
      )}
      {config.authMethod === "password" && !credentialStoreAvailable && (
        <p className="settings-form__hint">
          You will be prompted for a password each time you connect. Enable secure storage in
          Settings to save passwords.
        </p>
      )}
      {config.authMethod === "key" && (
        <>
          <div className="settings-form__field">
            <span className="settings-form__label">Key Path</span>
            <KeyPathInput
              value={config.keyPath ?? ""}
              onChange={(v) => onChange({ ...config, keyPath: v || undefined })}
              placeholder="~/.ssh/id_ed25519"
              testIdPrefix="agent-settings"
            />
          </div>
          <label className="settings-form__field">
            <span className="settings-form__label">Key Passphrase (optional)</span>
            <input
              type="password"
              value={config.password ?? ""}
              onChange={(e) => onChange({ ...config, password: e.target.value || undefined })}
              placeholder="Leave empty if unencrypted"
              data-testid="agent-settings-key-passphrase-input"
            />
          </label>
          {credentialStoreAvailable && (
            <>
              <label
                className="settings-form__field settings-form__field--checkbox"
                data-testid="agent-settings-save-passphrase-label"
              >
                <input
                  type="checkbox"
                  checked={config.savePassword ?? false}
                  onChange={(e) => onChange({ ...config, savePassword: e.target.checked })}
                  data-testid="agent-settings-save-passphrase-checkbox"
                />
                <span className="settings-form__label">Save passphrase</span>
              </label>
              <p className="settings-form__hint">
                {credentialStoreStatus?.mode === "keychain"
                  ? "Passphrase will be stored in the OS keychain."
                  : "Passphrase will be encrypted with your master password."}
              </p>
            </>
          )}
        </>
      )}
      <p className="settings-form__hint">
        This agent manages a shared SSH connection. Sessions (shell/serial) are created inside the
        agent after connecting.
      </p>
    </div>
  );
}
