import { useState, useCallback, useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { SerialPortScanPrefix } from "@/types/connection";

interface SerialPortSettingsProps {
  visibleFields?: Set<string>;
}

/**
 * Settings panel section for configuring Linux /dev serial port scan prefixes.
 * Built-in prefixes can be toggled on/off. User-added prefixes can also be deleted.
 */
export function SerialPortSettings({ visibleFields }: SerialPortSettingsProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [newPrefix, setNewPrefix] = useState("");
  const [addError, setAddError] = useState("");

  const prefixes: SerialPortScanPrefix[] = settings.serialPortScanPrefixes ?? [];

  const handleToggle = useCallback(
    (prefix: string) => {
      const updated = prefixes.map((p) =>
        p.prefix === prefix ? { ...p, enabled: !p.enabled } : p
      );
      updateSettings({ ...settings, serialPortScanPrefixes: updated });
    },
    [prefixes, settings, updateSettings]
  );

  const handleDelete = useCallback(
    (prefix: string) => {
      const updated = prefixes.filter((p) => p.prefix !== prefix);
      updateSettings({ ...settings, serialPortScanPrefixes: updated });
    },
    [prefixes, settings, updateSettings]
  );

  const handleAdd = useCallback(() => {
    const trimmed = newPrefix.trim();
    if (!trimmed) return;
    if (prefixes.some((p) => p.prefix === trimmed)) {
      setAddError("Prefix already exists.");
      return;
    }
    setAddError("");
    const entry: SerialPortScanPrefix = { prefix: trimmed, enabled: true, builtIn: false };
    updateSettings({ ...settings, serialPortScanPrefixes: [...prefixes, entry] });
    setNewPrefix("");
  }, [newPrefix, prefixes, settings, updateSettings]);

  const { builtIn, custom, enabledCount } = useMemo(() => {
    let enabled = 0;
    const bi: SerialPortScanPrefix[] = [];
    const cu: SerialPortScanPrefix[] = [];
    for (const p of prefixes) {
      if (p.builtIn) bi.push(p);
      else cu.push(p);
      if (p.enabled) enabled++;
    }
    return { builtIn: bi, custom: cu, enabledCount: enabled };
  }, [prefixes]);

  if (visibleFields && !visibleFields.has("serialPortScanPrefixes")) {
    return null;
  }

  return (
    <div className="settings-panel__section" data-testid="settings-serial-port-prefixes">
      <div className="settings-panel__section-header">
        <h3 className="settings-panel__section-title">Serial Port Scan Prefixes</h3>
        <span className="settings-panel__section-badge">
          {enabledCount} / {prefixes.length} enabled
        </span>
      </div>
      <p className="settings-panel__description">
        On Linux, termiHub scans <code>/dev</code> for device names matching these prefixes to find
        serial ports that the system library may not enumerate (e.g. <code>ttyAMA*</code> on
        Raspberry Pi). Toggle built-in entries on or off, or add custom prefixes for non-standard
        hardware.
      </p>

      {builtIn.length > 0 && (
        <ul className="settings-panel__file-list">
          {builtIn.map((p) => (
            <li key={p.prefix} className="settings-panel__file-item">
              <label className="settings-panel__toggle">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={() => handleToggle(p.prefix)}
                />
                <span className="settings-panel__toggle-slider" />
              </label>
              <code
                className={`settings-panel__file-path${!p.enabled ? " settings-panel__file-path--disabled" : ""}`}
              >
                {p.prefix}
              </code>
            </li>
          ))}
        </ul>
      )}

      {custom.length > 0 && (
        <>
          <h4 className="settings-panel__subsection-title">Custom</h4>
          <ul className="settings-panel__file-list">
            {custom.map((p) => (
              <li key={p.prefix} className="settings-panel__file-item">
                <label className="settings-panel__toggle">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={() => handleToggle(p.prefix)}
                  />
                  <span className="settings-panel__toggle-slider" />
                </label>
                <code
                  className={`settings-panel__file-path${!p.enabled ? " settings-panel__file-path--disabled" : ""}`}
                >
                  {p.prefix}
                </code>
                <button
                  className="settings-panel__file-remove"
                  onClick={() => handleDelete(p.prefix)}
                  title="Remove custom prefix"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="settings-panel__add-row">
        <input
          className="settings-panel__create-input"
          type="text"
          value={newPrefix}
          placeholder="e.g. ttyXYZ"
          onChange={(e) => {
            setNewPrefix(e.target.value);
            setAddError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
        />
        <button
          className="settings-panel__btn settings-panel__btn--primary"
          onClick={handleAdd}
          disabled={!newPrefix.trim()}
        >
          <Plus size={14} />
          Add
        </button>
      </div>
      {addError && <p className="settings-panel__error">{addError}</p>}
    </div>
  );
}
