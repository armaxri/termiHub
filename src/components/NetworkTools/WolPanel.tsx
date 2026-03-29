import { useState, useCallback, useEffect } from "react";
import { Power, Save, Trash2, Zap } from "lucide-react";
import {
  networkWolSend,
  networkWolDevicesList,
  networkWolDeviceSave,
  networkWolDeviceDelete,
} from "@/services/networkApi";
import type { WolDevice } from "@/types/network";
import { frontendLog } from "@/utils/frontendLog";

interface WolHistoryEntry {
  mac: string;
  sentAt: string;
}

/** Wake-on-LAN diagnostic tab content. */
export function WolPanel() {
  const [mac, setMac] = useState("");
  const [broadcast, setBroadcast] = useState("255.255.255.255");
  const [port, setPort] = useState(9);
  const [savedDevices, setSavedDevices] = useState<WolDevice[]>([]);
  const [history, setHistory] = useState<WolHistoryEntry[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const devices = await networkWolDevicesList();
      setSavedDevices(devices);
    } catch (err) {
      frontendLog("wol_panel", `Failed to load WoL devices: ${err}`);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const handleSend = useCallback(async () => {
    if (!mac.trim()) return;
    setError(null);
    setStatus(null);
    try {
      await networkWolSend(mac, broadcast, port);
      setStatus(`Magic packet sent to ${mac}`);
      setHistory((prev) => [{ mac, sentAt: new Date().toLocaleTimeString() }, ...prev.slice(0, 9)]);
    } catch (err) {
      setError(String(err));
      frontendLog("wol_panel", `WoL send failed: ${err}`);
    }
  }, [mac, broadcast, port]);

  const handleWakeDevice = useCallback(async (device: WolDevice) => {
    try {
      await networkWolSend(device.mac, device.broadcast, device.port);
      setHistory((prev) => [
        { mac: device.mac, sentAt: new Date().toLocaleTimeString() },
        ...prev.slice(0, 9),
      ]);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const handleSaveDevice = useCallback(async () => {
    if (!mac.trim()) return;
    const name = window.prompt("Device name:");
    if (!name) return;
    try {
      await networkWolDeviceSave({
        id: crypto.randomUUID(),
        name,
        mac,
        broadcast,
        port,
      });
      await loadDevices();
    } catch (err) {
      setError(String(err));
    }
  }, [mac, broadcast, port, loadDevices]);

  const handleDeleteDevice = useCallback(
    async (id: string) => {
      try {
        await networkWolDeviceDelete(id);
        await loadDevices();
      } catch (err) {
        setError(String(err));
      }
    },
    [loadDevices]
  );

  return (
    <div className="network-panel" data-testid="wol-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">Wake-on-LAN</span>
        <div className="network-panel__actions">
          <button
            className="network-panel__btn network-panel__btn--run"
            onClick={handleSend}
            disabled={!mac.trim()}
            data-testid="wol-send"
          >
            <Power size={14} />
            Send
          </button>
        </div>
      </div>

      <div className="network-panel__form">
        <label className="network-panel__field">
          <span>MAC Address</span>
          <input
            className="network-panel__input"
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            placeholder="AA:BB:CC:DD:EE:FF"
            data-testid="wol-mac"
          />
        </label>
        <label className="network-panel__field">
          <span>Broadcast</span>
          <input
            className="network-panel__input"
            value={broadcast}
            onChange={(e) => setBroadcast(e.target.value)}
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Port</span>
          <input
            className="network-panel__input"
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </label>
      </div>

      {status && <div className="network-panel__info">{status}</div>}
      {error && <div className="network-panel__error">{error}</div>}

      {/* Saved Devices */}
      <div className="network-panel__section-title">Saved Devices</div>
      {savedDevices.length === 0 && (
        <div className="network-panel__placeholder">No saved devices</div>
      )}
      {savedDevices.map((device) => (
        <div key={device.id} className="wol-device-row">
          <span className="wol-device-row__name">{device.name}</span>
          <span className="wol-device-row__mac">{device.mac}</span>
          <button
            className="network-panel__icon-btn"
            onClick={() => handleWakeDevice(device)}
            title="Wake"
          >
            <Zap size={13} />
          </button>
          <button
            className="network-panel__icon-btn network-panel__icon-btn--danger"
            onClick={() => handleDeleteDevice(device.id)}
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      <button
        className="network-panel__save-btn"
        onClick={handleSaveDevice}
        disabled={!mac.trim()}
        data-testid="wol-save-device"
      >
        <Save size={13} />
        Save Current
      </button>

      {/* History */}
      {history.length > 0 && (
        <>
          <div className="network-panel__section-title">History</div>
          {history.map((entry, i) => (
            <div key={i} className="network-panel__history-row">
              <span>{entry.sentAt}</span>
              <span>Sent magic packet to {entry.mac}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
