import { AppSettings } from "@/types/connection";

const DEFAULT_FONT_FAMILY =
  "'MesloLGS Nerd Font Mono', 'MesloLGS NF', 'CaskaydiaCove Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";

interface AppearanceSettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  visibleFields?: Set<string>;
}

export function AppearanceSettings({ settings, onChange, visibleFields }: AppearanceSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Appearance</h3>
      {show("theme") && (
        <label className="settings-form__field">
          <span className="settings-form__label">Theme</span>
          {/* TODO: Apply theme dynamically */}
          <select
            value={settings.theme ?? "dark"}
            onChange={(e) =>
              onChange({
                ...settings,
                theme: e.target.value as "dark" | "light" | "system",
              })
            }
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
          <span className="settings-form__hint">Application color theme.</span>
        </label>
      )}
      {show("fontFamily") && (
        <label className="settings-form__field">
          <span className="settings-form__label">Font Family</span>
          <input
            type="text"
            value={settings.fontFamily ?? ""}
            onChange={(e) => onChange({ ...settings, fontFamily: e.target.value || undefined })}
            placeholder={DEFAULT_FONT_FAMILY}
          />
          <span className="settings-form__hint">
            Terminal font family. Leave empty to use the default Nerd Font chain.
          </span>
        </label>
      )}
      {show("fontSize") && (
        <label className="settings-form__field">
          <span className="settings-form__label">Font Size</span>
          <input
            type="number"
            min={8}
            max={32}
            value={settings.fontSize ?? 14}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              onChange({ ...settings, fontSize: isNaN(val) ? undefined : val });
            }}
          />
          <span className="settings-form__hint">Terminal font size in pixels (8–32).</span>
        </label>
      )}
    </div>
  );
}
