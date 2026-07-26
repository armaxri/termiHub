import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Puzzle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { InstalledPlugin, JsonValue } from "@/types/plugin";
import { ConnectionSettingsForm } from "@/components/DynamicForm";
import { hasSettings, pluginTypeIcon } from "@/components/Plugins/pluginPresentation";
import { pluginSettingsDefaults, pluginSettingsToSchema } from "./pluginSettingsSchema";
import "./PluginSettingsSection.css";

/** Debounce before a plugin's edited settings are persisted. */
const SAVE_DEBOUNCE_MS = 300;
/** How long the inline per-plugin "Saved" acknowledgment stays visible. */
const SAVED_ACK_MS = 1500;

interface PluginSettingsSectionProps {
  /**
   * When set, scroll this plugin's group into view and briefly highlight it —
   * used when the Plugin Manager's "Settings…" action deep-links here (#2000).
   */
  focusPluginId?: string | null;
}

/**
 * The Plugins settings category (#2000): one group per installed plugin that
 * declares `settings` in its manifest, each rendered from that schema by the
 * generic `DynamicForm` and persisted through `get_plugin_settings` /
 * `update_plugin_settings`. Plugins that declare no settings never appear here.
 */
export function PluginSettingsSection({ focusPluginId }: PluginSettingsSectionProps) {
  const plugins = useAppStore((s) => s.plugins);
  const getPluginSettings = useAppStore((s) => s.getPluginSettings);
  const updatePluginSettings = useAppStore((s) => s.updatePluginSettings);

  // Plugins with at least one declared setting, in install-list order.
  const configurable = useMemo(() => plugins.filter((p) => hasSettings(p.manifest)), [plugins]);

  // Per-plugin form values, populated once the persisted settings load. A
  // plugin is considered loaded exactly when it has an entry here — the form is
  // gated on this so its (init-only) default values are the correct ones.
  const [values, setValues] = useState<Record<string, Record<string, JsonValue>>>({});
  const [savedAckId, setSavedAckId] = useState<string | null>(null);
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Load each configurable plugin's persisted settings, layered over the
  // schema defaults. Runs whenever the configurable set changes (install/enable).
  useEffect(() => {
    let cancelled = false;
    for (const p of configurable) {
      const { id, settings } = p.manifest;
      const defaults = pluginSettingsDefaults(settings ?? {});
      getPluginSettings(id)
        .catch(() => ({}) as Record<string, JsonValue>)
        .then((stored) => {
          if (cancelled) return;
          setValues((prev) => ({ ...prev, [id]: { ...defaults, ...stored } }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [configurable, getPluginSettings]);

  // Clear timers on unmount.
  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (ackTimer.current) clearTimeout(ackTimer.current);
    };
  }, []);

  // Scroll the deep-linked plugin into view once its group has mounted.
  useEffect(() => {
    if (!focusPluginId) return;
    const el = groupRefs.current.get(focusPluginId);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focusPluginId, values]);

  const handleChange = useCallback(
    (pluginId: string) => (next: Record<string, unknown>) => {
      const typed = next as Record<string, JsonValue>;
      setValues((prev) => ({ ...prev, [pluginId]: typed }));

      const timers = saveTimers.current;
      const existing = timers.get(pluginId);
      if (existing) clearTimeout(existing);
      timers.set(
        pluginId,
        setTimeout(() => {
          timers.delete(pluginId);
          updatePluginSettings(pluginId, typed)
            .then(() => {
              setSavedAckId(pluginId);
              if (ackTimer.current) clearTimeout(ackTimer.current);
              ackTimer.current = setTimeout(() => setSavedAckId(null), SAVED_ACK_MS);
            })
            .catch(() => {
              // The store already surfaced a recoverable error toast.
            });
        }, SAVE_DEBOUNCE_MS)
      );
    },
    [updatePluginSettings]
  );

  if (configurable.length === 0) {
    return (
      <div className="settings-panel__category" data-testid="plugin-settings-section">
        <h3 className="settings-panel__category-title">Plugins</h3>
        <div className="settings-panel__empty" data-testid="plugin-settings-empty">
          No installed plugin has configurable settings.
        </div>
      </div>
    );
  }

  return (
    <div className="settings-panel__category" data-testid="plugin-settings-section">
      <h3 className="settings-panel__category-title">Plugins</h3>
      <p className="settings-panel__description">
        Configure settings for installed plugins that declare them. Changes are saved automatically.
      </p>

      {configurable.map((plugin) => (
        <PluginSettingsGroup
          key={plugin.manifest.id}
          plugin={plugin}
          values={values[plugin.manifest.id]}
          saved={savedAckId === plugin.manifest.id}
          highlighted={focusPluginId === plugin.manifest.id}
          onChange={handleChange(plugin.manifest.id)}
          registerRef={(el) => {
            if (el) groupRefs.current.set(plugin.manifest.id, el);
            else groupRefs.current.delete(plugin.manifest.id);
          }}
        />
      ))}
    </div>
  );
}

interface PluginSettingsGroupProps {
  plugin: InstalledPlugin;
  /** Loaded form values, or undefined until the persisted settings resolve. */
  values: Record<string, JsonValue> | undefined;
  saved: boolean;
  highlighted: boolean;
  onChange: (next: Record<string, unknown>) => void;
  registerRef: (el: HTMLDivElement | null) => void;
}

/** One plugin's settings card: identity/badge header plus its `DynamicForm`. */
function PluginSettingsGroup({
  plugin,
  values,
  saved,
  highlighted,
  onChange,
  registerRef,
}: PluginSettingsGroupProps) {
  const { manifest } = plugin;
  const Icon = pluginTypeIcon(manifest.extensions) ?? Puzzle;
  const schema = useMemo(
    () => pluginSettingsToSchema(manifest.settings ?? {}, manifest.id),
    [manifest.settings, manifest.id]
  );

  return (
    <div
      ref={registerRef}
      className={`settings-panel__section plugin-settings__group${
        highlighted ? " plugin-settings__group--highlighted" : ""
      }`}
      data-testid={`plugin-settings-${manifest.id}`}
    >
      <div className="plugin-settings__header">
        <Icon size={16} className="plugin-settings__icon" aria-hidden="true" />
        <h3 className="settings-panel__section-title">{manifest.name}</h3>
        <span className="settings-panel__badge">plugin</span>
        <span
          className={`plugin-settings__saved${saved ? " plugin-settings__saved--visible" : ""}`}
          role="status"
          aria-live="polite"
          data-testid={`plugin-settings-saved-${manifest.id}`}
        >
          {saved && (
            <>
              <Check size={12} aria-hidden="true" />
              Saved
            </>
          )}
        </span>
      </div>
      {manifest.description && (
        <p className="settings-panel__description">{manifest.description}</p>
      )}

      {/* Gate the form on loaded values: ConnectionSettingsForm seeds its state
          from `settings` only on mount, so mounting before the persisted values
          arrive would strand them. Until then, show a light placeholder. */}
      {values ? (
        <ConnectionSettingsForm schema={schema} settings={values} onChange={onChange} />
      ) : (
        <div className="settings-panel__empty" data-testid={`plugin-settings-loading-${manifest.id}`}>
          Loading…
        </div>
      )}
    </div>
  );
}
