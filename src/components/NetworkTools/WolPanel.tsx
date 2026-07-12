import { useState, useCallback, useEffect, useMemo } from "react";
import { Power, Save, Trash2, Zap } from "lucide-react";
import { Button, Tooltip, toast, Modal, Field, Input } from "@/components/ui";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import { useFormSubmit } from "@/hooks/useFormSubmit";
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

  const macError = useMemo(() => validateMac(mac), [mac]);
  const portError = validatePort(port);
  const broadcastError = validateHost(broadcast, "Broadcast address");
  const canSend = !macError && !portError && !broadcastError;
  const [savedDevices, setSavedDevices] = useState<WolDevice[]>([]);
  const [history, setHistory] = useState<WolHistoryEntry[]>([]);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

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
    setSentMessage(null);
    try {
      await networkWolSend(mac, broadcast, Number(port));
      setSentMessage(`Magic packet sent to ${mac}`);
      setHistory((prev) => [{ mac, sentAt: new Date().toLocaleTimeString() }, ...prev.slice(0, 9)]);
    } catch (err) {
      setError(String(err));
      frontendLog("wol_panel", `WoL send failed: ${err}`);
      throw err; // keep the async Button in its error path (no false success flash)
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
  // A mouse click goes through the Button's onClick so its async lifecycle drives
  // the pending affordance; useFormSubmit swallows the Enter-path rejection.
  const handleSubmit = useFormSubmit(canSend, handleSend);

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
            pendingLabel="Sending…"
            errorToast={false}
            disabled={!canSend}
            onClick={(e) => {
              e.preventDefault();
              return handleSend();
            }}
            data-testid="wol-send"
          >
            Send
          </Button>
        </div>
      </div>

      <div className="network-panel__form">
        <NetworkTextField
          label="MAC Address"
          value={mac}
          onChange={setMac}
          error={macError}
          inputRef={macRef}
          placeholder="AA:BB:CC:DD:EE:FF"
          data-testid="wol-mac"
        />
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

      {sentMessage && <div className="network-panel__info">{sentMessage}</div>}
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
