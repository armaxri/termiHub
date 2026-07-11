import { AppSettings } from "@/types/connection";
import { Select } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import { SettingsField } from "./SettingsField";

/** Static theme options, hoisted so they are not rebuilt on every render. */
const THEME_OPTIONS: SelectOption[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "solarized-dark", label: "Solarized Dark" },
  { value: "solarized-light", label: "Solarized Light" },
  { value: "system", label: "System" },
];

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
        <SettingsField label="Theme" hint="Application color theme.">
          <Select
            data-testid="appearance-theme-select"
            value={settings.theme ?? "dark"}
            onChange={(value) =>
              onChange({
                ...settings,
                theme: value as "dark" | "light" | "solarized-dark" | "solarized-light" | "system",
              })
            }
            options={THEME_OPTIONS}
          />
        </SettingsField>
      )}
      {show("fontFamily") && (
        <SettingsField
          label="Font Family"
          hint="Terminal font family. Leave empty to use the default Nerd Font chain."
        >
          <input
            type="text"
            value={settings.fontFamily ?? ""}
            onChange={(e) => onChange({ ...settings, fontFamily: e.target.value || undefined })}
            placeholder={DEFAULT_FONT_FAMILY}
          />
        </SettingsField>
      )}
      {show("fontSize") && (
        <SettingsField label="Font Size" hint="Terminal font size in pixels (8–32).">
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
        </SettingsField>
      )}
      {show("lineHeight") && (
        <SettingsField
          label="Line Height"
          hint="Terminal line height (0.8–2.0). Use 1.0 for seamless box-drawing characters."
        >
          <input
            type="number"
            min={0.8}
            max={2.0}
            step={0.1}
            value={settings.lineHeight ?? 1.0}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              onChange({ ...settings, lineHeight: isNaN(val) ? undefined : val });
            }}
          />
        </SettingsField>
      )}
    </div>
  );
}
