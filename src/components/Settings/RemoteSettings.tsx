import { RemoteConfig } from "@/types/terminal";

interface RemoteSettingsProps {
  config: RemoteConfig;
  onChange: (config: RemoteConfig) => void;
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/**
 * Settings form for Remote Agent connections.
 * Combines SSH connection fields with a session type selector
 * and conditional shell/serial configuration.
 */
export function RemoteSettings({ config, onChange }: RemoteSettingsProps) {
  return (
    <div className="settings-form">
      <label className="settings-form__field">
        <span className="settings-form__label">Host</span>
        <input
          type="text"
          value={config.host}
          onChange={(e) => onChange({ ...config, host: e.target.value })}
          placeholder="192.168.1.100"
          data-testid="remote-settings-host-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Port</span>
        <input
          type="number"
          value={config.port}
          onChange={(e) => onChange({ ...config, port: parseInt(e.target.value) || 22 })}
          data-testid="remote-settings-port-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Username</span>
        <input
          type="text"
          value={config.username}
          onChange={(e) => onChange({ ...config, username: e.target.value })}
          placeholder="pi"
          data-testid="remote-settings-username-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Auth Method</span>
        <select
          value={config.authMethod}
          onChange={(e) =>
            onChange({ ...config, authMethod: e.target.value as "password" | "key" | "agent" })
          }
          data-testid="remote-settings-auth-method-select"
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
        <label className="settings-form__field">
          <span className="settings-form__label">Key Path</span>
          <input
            type="text"
            value={config.keyPath ?? ""}
            onChange={(e) => onChange({ ...config, keyPath: e.target.value })}
            placeholder="~/.ssh/id_rsa"
            data-testid="remote-settings-key-path-input"
          />
        </label>
      )}

      <label className="settings-form__field">
        <span className="settings-form__label">Session Type</span>
        <select
          value={config.sessionType}
          onChange={(e) =>
            onChange({ ...config, sessionType: e.target.value as "shell" | "serial" })
          }
          data-testid="remote-settings-session-type-select"
        >
          <option value="shell">Shell</option>
          <option value="serial">Serial</option>
        </select>
      </label>

      {config.sessionType === "shell" && (
        <label className="settings-form__field">
          <span className="settings-form__label">Shell</span>
          <input
            type="text"
            value={config.shell ?? ""}
            onChange={(e) => onChange({ ...config, shell: e.target.value || undefined })}
            placeholder="/bin/bash"
            data-testid="remote-settings-shell-input"
          />
        </label>
      )}

      {config.sessionType === "serial" && (
        <>
          <label className="settings-form__field">
            <span className="settings-form__label">Serial Port</span>
            <input
              type="text"
              value={config.serialPort ?? ""}
              onChange={(e) => onChange({ ...config, serialPort: e.target.value })}
              placeholder="/dev/ttyUSB0"
              data-testid="remote-settings-serial-port-input"
            />
          </label>
          <label className="settings-form__field">
            <span className="settings-form__label">Baud Rate</span>
            <select
              value={config.baudRate ?? 115200}
              onChange={(e) => onChange({ ...config, baudRate: parseInt(e.target.value) })}
              data-testid="remote-settings-baud-rate-select"
            >
              {BAUD_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-form__field">
            <span className="settings-form__label">Data Bits</span>
            <select
              value={config.dataBits ?? 8}
              onChange={(e) =>
                onChange({ ...config, dataBits: parseInt(e.target.value) as 5 | 6 | 7 | 8 })
              }
              data-testid="remote-settings-data-bits-select"
            >
              <option value={5}>5</option>
              <option value={6}>6</option>
              <option value={7}>7</option>
              <option value={8}>8</option>
            </select>
          </label>
          <label className="settings-form__field">
            <span className="settings-form__label">Stop Bits</span>
            <select
              value={config.stopBits ?? 1}
              onChange={(e) => onChange({ ...config, stopBits: parseInt(e.target.value) as 1 | 2 })}
              data-testid="remote-settings-stop-bits-select"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          <label className="settings-form__field">
            <span className="settings-form__label">Parity</span>
            <select
              value={config.parity ?? "none"}
              onChange={(e) =>
                onChange({ ...config, parity: e.target.value as "none" | "odd" | "even" })
              }
              data-testid="remote-settings-parity-select"
            >
              <option value="none">None</option>
              <option value="odd">Odd</option>
              <option value="even">Even</option>
            </select>
          </label>
          <label className="settings-form__field">
            <span className="settings-form__label">Flow Control</span>
            <select
              value={config.flowControl ?? "none"}
              onChange={(e) =>
                onChange({
                  ...config,
                  flowControl: e.target.value as "none" | "hardware" | "software",
                })
              }
              data-testid="remote-settings-flow-control-select"
            >
              <option value="none">None</option>
              <option value="hardware">Hardware (RTS/CTS)</option>
              <option value="software">Software (XON/XOFF)</option>
            </select>
          </label>
        </>
      )}

      <label className="settings-form__field">
        <span className="settings-form__label">Title (optional)</span>
        <input
          type="text"
          value={config.title ?? ""}
          onChange={(e) => onChange({ ...config, title: e.target.value || undefined })}
          placeholder="e.g. Build Session"
          data-testid="remote-settings-title-input"
        />
      </label>
    </div>
  );
}
