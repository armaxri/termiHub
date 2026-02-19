import { TelnetConfig } from "@/types/terminal";
import { parseHostPort } from "@/utils/parseHostPort";

interface TelnetSettingsProps {
  config: TelnetConfig;
  onChange: (config: TelnetConfig) => void;
}

export function TelnetSettings({ config, onChange }: TelnetSettingsProps) {
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
          placeholder="192.168.1.200"
          data-testid="telnet-settings-host-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Port</span>
        <input
          type="number"
          value={config.port}
          onChange={(e) => onChange({ ...config, port: parseInt(e.target.value) || 23 })}
          data-testid="telnet-settings-port-input"
        />
      </label>
    </div>
  );
}
