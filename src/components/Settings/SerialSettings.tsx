import { SerialConfig } from "@/types/terminal";

interface SerialSettingsProps {
  config: SerialConfig;
  onChange: (config: SerialConfig) => void;
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function SerialSettings({ config, onChange }: SerialSettingsProps) {
  return (
    <div className="settings-form">
      <label className="settings-form__field">
        <span className="settings-form__label">Port</span>
        <input
          type="text"
          value={config.port}
          onChange={(e) => onChange({ ...config, port: e.target.value })}
          placeholder="/dev/ttyUSB0"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Baud Rate</span>
        <select
          value={config.baudRate}
          onChange={(e) => onChange({ ...config, baudRate: parseInt(e.target.value) })}
        >
          {BAUD_RATES.map((rate) => (
            <option key={rate} value={rate}>{rate}</option>
          ))}
        </select>
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Data Bits</span>
        <select
          value={config.dataBits}
          onChange={(e) => onChange({ ...config, dataBits: parseInt(e.target.value) as 5 | 6 | 7 | 8 })}
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
          value={config.stopBits}
          onChange={(e) => onChange({ ...config, stopBits: parseInt(e.target.value) as 1 | 2 })}
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Parity</span>
        <select
          value={config.parity}
          onChange={(e) => onChange({ ...config, parity: e.target.value as "none" | "odd" | "even" })}
        >
          <option value="none">None</option>
          <option value="odd">Odd</option>
          <option value="even">Even</option>
        </select>
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Flow Control</span>
        <select
          value={config.flowControl}
          onChange={(e) => onChange({ ...config, flowControl: e.target.value as "none" | "hardware" | "software" })}
        >
          <option value="none">None</option>
          <option value="hardware">Hardware (RTS/CTS)</option>
          <option value="software">Software (XON/XOFF)</option>
        </select>
      </label>
    </div>
  );
}
