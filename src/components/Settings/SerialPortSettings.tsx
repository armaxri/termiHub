import { useState, useCallback, useMemo, useId } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { SerialPortScanPrefix } from "@/types/connection";
import { Button, Input, Toggle, Tooltip } from "@/components/ui";
import { isImeComposing } from "@/utils/imeComposition";
import { getPlatform, type Platform } from "@/utils/platform";
import { t, tf } from "@/i18n/catalog";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

interface SerialPortSettingsProps {
  visibleFields?: Set<string>;
  /**
   * Host platform. Defaults to the detected one; injected by tests. The `/dev`
   * prefix scan only runs on Linux, so elsewhere the list is folded (#5712).
   */
  platform?: Platform;
}

/**
 * Settings panel section for configuring Linux /dev serial port scan prefixes.
 * Built-in prefixes can be toggled on/off. User-added prefixes can also be deleted.
 * On Linux the built-ins render as a compact chip grid; on other platforms the
 * whole list folds behind a one-line note and a disclosure (#5712), since the
 * scan never runs there (the settings may still be shared with a Linux host).
 */
export function SerialPortSettings({
  visibleFields,
  platform = getPlatform(),
}: SerialPortSettingsProps) {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [newPrefix, setNewPrefix] = useState("");
  const [addError, setAddError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const prefixes = useMemo(
    () => settings.serialPortScanPrefixes ?? [],
    [settings.serialPortScanPrefixes]
  );

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

  const prefixToggle = (p: SerialPortScanPrefix) => (
    <Toggle
      aria-label={`Toggle serial port prefix ${p.prefix}`}
      checked={p.enabled}
      onCheckedChange={() => handleToggle(p.prefix)}
    />
  );
  const prefixLabel = (p: SerialPortScanPrefix) => (
    <code
      className={`settings-panel__file-path${!p.enabled ? " settings-panel__file-path--disabled" : ""}`}
    >
      {p.prefix}
    </code>
  );

  const isLinux = platform === "linux";
  const showList = isLinux || expanded;

  return (
    <div className="settings-panel__section" data-testid="settings-serial-port-prefixes">
      <div className="settings-panel__section-header">
        <SettingsSectionHeading>Serial port scan prefixes</SettingsSectionHeading>
        <span className="settings-panel__section-badge">
          {enabledCount} / {prefixes.length} enabled
        </span>
      </div>
      {isLinux ? (
        <p className="settings-panel__description">
          termiHub scans <code>/dev</code> for device names matching these prefixes to find serial
          ports that the system library may not enumerate (e.g. <code>ttyAMA*</code> on Raspberry
          Pi). Toggle built-in entries on or off, or add custom prefixes for non-standard hardware.
          Disabling a prefix hides all of its ports, including ones the system library lists.
        </p>
      ) : (
        <div className="settings-panel__prefix-note" data-testid="settings-serial-prefixes-note">
          <p className="settings-panel__description">{t("serialPrefixes.offLinux.note")}</p>
          <Button
            variant="ghost"
            size="sm"
            icon={expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((v) => !v)}
            data-testid="settings-serial-prefixes-disclosure"
          >
            {expanded
              ? t("serialPrefixes.offLinux.hide")
              : tf("serialPrefixes.offLinux.show", { count: prefixes.length })}
          </Button>
        </div>
      )}

      {showList && (
        <div id={listId} data-testid="settings-serial-prefixes-list">
          {builtIn.length > 0 && (
            <ul className="settings-panel__prefix-grid" data-testid="settings-serial-prefix-grid">
              {builtIn.map((p) => (
                <li key={p.prefix} className="settings-panel__prefix-chip">
                  {prefixToggle(p)}
                  {prefixLabel(p)}
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
                    {prefixToggle(p)}
                    {prefixLabel(p)}
                    <Tooltip content="Remove custom prefix">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon={<Trash2 size={14} />}
                        onClick={() => handleDelete(p.prefix)}
                        aria-label="Remove custom prefix"
                      />
                    </Tooltip>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="settings-panel__add-row">
            <Input
              className="settings-panel__create-input"
              value={newPrefix}
              placeholder="e.g. ttyXYZ"
              onChange={(e) => {
                setNewPrefix(e.target.value);
                setAddError("");
              }}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Enter") handleAdd();
              }}
            />
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={14} />}
              onClick={handleAdd}
              disabled={!newPrefix.trim()}
            >
              Add
            </Button>
          </div>
          {addError && <p className="settings-panel__error">{addError}</p>}
        </div>
      )}
    </div>
  );
}
