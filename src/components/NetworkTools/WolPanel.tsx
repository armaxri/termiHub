import { useState, useCallback, useEffect } from "react";
import { Power, Save, Trash2, Zap } from "lucide-react";
import { Button, Tooltip, toast } from "@/components/ui";
import {
  networkWolSend,
  networkWolDevicesList,
  networkWolDeviceSave,
  networkWolDeviceDelete,
} from "@/services/networkApi";
import type { WolDevice } from "@/types/network";
import { NetworkNumberField } from "./NetworkNumberField";
import { validatePort, validateHost } from "@/utils/fieldValidation";
import { frontendLog } from "@/utils/frontendLog";

interface WolHistoryEntry {
  mac: string;
  sentAt: string;
}

/** Wake-on-LAN diagnostic tab content. */
export function WolPanel() {
  const [mac, setMac] = useState("");
  const [broadcast, setBroadcast] = useState("255.255.255.255");
  const [port, setPort] = useState<number | "">(9);

  const portError = validatePort(port);
  const broadcastError = validateHost(broadcast, "Broadcast address");
  const canSend = !!mac.trim() && !portError && !broadcastError;
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
    if (!mac.trim() || portError || broadcastError) return;
    setError(null);
    setStatus(null);
    try {
      await networkWolSend(mac, broadcast, Number(port));
      setStatus(`Magic packet sent to ${mac}`);
      setHistory((prev) => [{ mac, sentAt: new Date().toLocaleTimeString() }, ...prev.slice(0, 9)]);
    } catch (err) {
      setError(String(err));
      frontendLog("wol_panel", `WoL send failed: ${err}`);
    }
  }, [mac, broadcast, port, portError, broadcastError]);

  const handleWakeDevice = useCallback(async (device: WolDevice) => {
    try {
      await networkWolSend(device.mac, device.broadcast, device.port);
      setHistory((prev) => [
        { mac: device.mac, sentAt: new Date().toLocaleTimeString() },
        ...prev.slice(0, 9),
      ]);
      toast.success(`Magic packet sent to ${device.name}`);
    } catch (err) {
      setError(String(err));
      frontendLog("wol_panel", `WoL wake failed: ${err}`);
      toast.error(`Wake failed: ${err}`);
    }
  }, []);

  const handleSaveDevice = useCallback(async () => {
    if (!mac.trim() || portError || broadcastError) return;
    const name = window.prompt("Device name:");
    if (!name) return;
    try {
      await networkWolDeviceSave({
        id: crypto.randomUUID(),
        name,
        mac,
        broadcast,
        port: Number(port),
      });
      await loadDevices();
      toast.success(`Saved device "${name}"`);
    } catch (err) {
      setError(String(err));
      frontendLog("wol_panel", `WoL device save failed: ${err}`);
      toast.error(`Save failed: ${err}`);
    }
  }, [mac, broadcast, port, portError, broadcastError, loadDevices]);

  const handleDeleteDevice = useCallback(
    async (id: string) => {
      try {
        await networkWolDeviceDelete(id);
        await loadDevices();
      } catch (err) {
        setError(String(err));
        frontendLog("wol_panel", `WoL device delete failed: ${err}`);
        toast.error(`Delete failed: ${err}`);
      }
    },
    [loadDevices]
  );

  return (
    <div className="network-panel" data-testid="wol-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">Wake-on-LAN</span>
        <div className="network-panel__actions">
          <Button
            variant="primary"
            size="sm"
            icon={<Power size={14} />}
            onClick={handleSend}
            disabled={!canSend}
            data-testid="wol-send"
          >
            Send
          </Button>
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
            className={`network-panel__input${broadcastError ? " network-panel__input--error" : ""}`}
            value={broadcast}
            onChange={(e) => setBroadcast(e.target.value)}
            aria-invalid={broadcastError ? true : undefined}
          />
          {broadcastError && <span className="network-panel__field-error">{broadcastError}</span>}
        </label>
        <NetworkNumberField
          label="Port"
          value={port}
          onChange={setPort}
          error={portError}
          small
          data-testid="wol-port"
        />
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
          <Tooltip content="Wake" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<Zap size={13} />}
              onClick={() => handleWakeDevice(device)}
              aria-label={`Wake ${device.name}`}
            />
          </Tooltip>
          <Tooltip content="Delete" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={13} />}
              onClick={() => handleDeleteDevice(device.id)}
              aria-label={`Delete ${device.name}`}
            />
          </Tooltip>
        </div>
      ))}

      <Button
        variant="secondary"
        size="sm"
        icon={<Save size={13} />}
        onClick={handleSaveDevice}
        disabled={!canSend}
        data-testid="wol-save-device"
        style={{ alignSelf: "flex-start" }}
      >
        Save Current
      </Button>

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
