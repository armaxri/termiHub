import { useState, useCallback, useEffect, useMemo, type FormEvent } from "react";
import { Power, Save, Trash2, Zap } from "lucide-react";
import { Button, Tooltip, toast, Modal, Field, Input } from "@/components/ui";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import {
  networkWolSend,
  networkWolDevicesList,
  networkWolDeviceSave,
  networkWolDeviceDelete,
} from "@/services/networkApi";
import type { WolDevice } from "@/types/network";
import { NetworkNumberField } from "./NetworkNumberField";
import { NetworkTextField } from "./NetworkTextField";
import { validatePort, validateHost, validateMac } from "@/utils/fieldValidation";
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

  const macRef = useAutofocusSelect<HTMLInputElement>();

  const portError = validatePort(port);
  const broadcastError = validateHost(broadcast, "Broadcast address");
  const canSend = !!mac.trim() && !portError && !broadcastError;
  const [savedDevices, setSavedDevices] = useState<WolDevice[]>([]);
  const [history, setHistory] = useState<WolHistoryEntry[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  const macError = useMemo(() => validateMac(mac), [mac]);
  const canSaveDevice = saveName.trim().length > 0 && !macError;

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
    if (!canSend) return;
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
  }, [mac, broadcast, port, canSend]);

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

  const openSaveModal = useCallback(() => {
    if (!canSend) return;
    setSaveName("");
    setSaveModalOpen(true);
  }, [canSend]);

  // Enter submits the form → send the magic packet (respects the disabled state).
  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!canSend) return;
      void handleSend();
    },
    [canSend, handleSend]
  );

  const handleConfirmSave = useCallback(async () => {
    const name = saveName.trim();
    if (!name || macError) return;
    try {
      await networkWolDeviceSave({
        id: crypto.randomUUID(),
        name,
        mac,
        broadcast,
        port: Number(port),
      });
      await loadDevices();
      setSaveModalOpen(false);
      toast.success(`Saved device "${name}"`);
    } catch (err) {
      setError(String(err));
      frontendLog("wol_panel", `WoL device save failed: ${err}`);
      toast.error(`Save failed: ${err}`);
      throw err; // keep the async Button in its error path (no success flash)
    }
  }, [saveName, macError, mac, broadcast, port, loadDevices]);

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
    <form className="network-panel" data-testid="wol-panel" onSubmit={handleSubmit}>
      <div className="network-panel__header">
        <span className="network-panel__title">Wake-on-LAN</span>
        <div className="network-panel__actions">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<Power size={14} />}
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
            ref={macRef}
            className="network-panel__input"
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            placeholder="AA:BB:CC:DD:EE:FF"
            data-testid="wol-mac"
          />
        </label>
        <NetworkTextField
          label="Broadcast"
          value={broadcast}
          onChange={setBroadcast}
          error={broadcastError}
          data-testid="wol-broadcast"
        />
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
        onClick={openSaveModal}
        disabled={!canSend}
        data-testid="wol-save-device"
        style={{ alignSelf: "flex-start" }}
      >
        Save Current
      </Button>

      <Modal
        open={saveModalOpen}
        onOpenChange={setSaveModalOpen}
        title="Save Wake-on-LAN Device"
        description="Give this device a name to save its MAC address, broadcast, and port."
        data-testid="wol-save-modal"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setSaveModalOpen(false)}
              data-testid="wol-save-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirmSave}
              errorToast={false}
              disabled={!canSaveDevice}
              data-testid="wol-save-confirm"
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Device name" htmlFor="wol-save-name">
          <Input
            id="wol-save-name"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSaveDevice) {
                e.preventDefault();
                void handleConfirmSave();
              }
            }}
            placeholder="e.g. Office NAS"
            autoFocus
            data-testid="wol-save-name"
          />
        </Field>
        <Field label="MAC address" htmlFor="wol-save-mac" error={macError ?? undefined}>
          <Input id="wol-save-mac" value={mac} readOnly data-testid="wol-save-mac" />
        </Field>
      </Modal>

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
    </form>
  );
}
