import { useState, useEffect } from "react";
import { SerialConfig } from "@/types/terminal";
import { listSerialPorts } from "@/services/api";

interface SerialSettingsProps {
  config: SerialConfig;
  onChange: (config: SerialConfig) => void;
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function SerialSettings({ config, onChange }: SerialSettingsProps) {
  const [ports, setPorts] = useState<string[]>([]);

  useEffect(() => {
    listSerialPorts()
      .then(setPorts)
      .catch(() => setPorts([]));
  }, []);

  return (
    <div className="settings-form">
      <label className="settings-form__field">
        <span className="settings-form__label">Port</span>
        {ports.length > 0 ? (
          <select
            value={config.port}
            onChange={(e) => onChange({ ...config, port: e.target.value })}
            data-testid="serial-settings-port-select"
          >
            <option value="">Select port...</option>
            {ports.map((port) => (
              <option key={port} value={port}>
                {port}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={config.port}
            onChange={(e) => onChange({ ...config, port: e.target.value })}
            placeholder="/dev/ttyUSB0"
            data-testid="serial-settings-port-input"
          />
        )}
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Baud Rate</span>
        <select
          value={config.baudRate}
          onChange={(e) => onChange({ ...config, baudRate: parseInt(e.target.value) })}
          data-testid="serial-settings-baud-rate-select"
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
          value={config.dataBits}
          onChange={(e) =>
            onChange({ ...config, dataBits: parseInt(e.target.value) as 5 | 6 | 7 | 8 })
          }
          data-testid="serial-settings-data-bits-select"
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
          data-testid="serial-settings-stop-bits-select"
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Parity</span>
        <select
          value={config.parity}
          onChange={(e) =>
            onChange({ ...config, parity: e.target.value as "none" | "odd" | "even" })
          }
          data-testid="serial-settings-parity-select"
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
          onChange={(e) =>
            onChange({ ...config, flowControl: e.target.value as "none" | "hardware" | "software" })
          }
          data-testid="serial-settings-flow-control-select"
        >
          <option value="none">None</option>
          <option value="hardware">Hardware (RTS/CTS)</option>
          <option value="software">Software (XON/XOFF)</option>
        </select>
      </label>
    </div>
  );
}
