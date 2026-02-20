import { RemoteAgentConfig } from "@/types/terminal";
import { parseHostPort } from "@/utils/parseHostPort";
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
      {config.authMethod === "key" && (
        <div className="settings-form__field">
          <span className="settings-form__label">Key Path</span>
          <KeyPathInput
            value={config.keyPath ?? ""}
            onChange={(v) => onChange({ ...config, keyPath: v || undefined })}
            placeholder="~/.ssh/id_ed25519"
            testIdPrefix="agent-settings"
          />
        </div>
      )}
      <p className="settings-form__hint">
        This agent manages a shared SSH connection. Sessions (shell/serial) are created inside the
        agent after connecting.
      </p>
    </div>
  );
}
