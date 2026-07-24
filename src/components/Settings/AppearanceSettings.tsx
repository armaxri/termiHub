import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { AppSettings } from "@/types/connection";
import { Button, NumberInput, Select, toast } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import {
  applyTheme,
  createCustomTheme,
  customThemeId,
  customThemeSetting,
  dedupeThemeName,
  findCustomTheme,
  isCustomThemeSetting,
  parseThemeFile,
  serializeTheme,
  themeFileName,
} from "@/themes";
import type { ThemeDefinition, ThemeImportResult } from "@/themes";
import { ThemeEditor } from "@/components/ThemeEditor/ThemeEditor";
import { SettingsField } from "./SettingsField";
import "./AppearanceSettings.css";

/** Built-in theme options, hoisted so they are not rebuilt on every render. */
const BUILTIN_THEME_OPTIONS: SelectOption[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "solarized-dark", label: "Solarized Dark" },
  { value: "solarized-light", label: "Solarized Light" },
  { value: "system", label: "System" },
];

/** Built-in ids usable as a base for a brand-new custom theme. */
const BUILTIN_BASE_IDS = new Set(["dark", "light", "solarized-dark", "solarized-light"]);

const DEFAULT_FONT_FAMILY =
  "'MesloLGS Nerd Font Mono', 'MesloLGS NF', 'CaskaydiaCove Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";

interface AppearanceSettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  visibleFields?: Set<string>;
}

export function AppearanceSettings({ settings, onChange, visibleFields }: AppearanceSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  /** The theme currently open in the editor (new or a copy of an existing one). */
  const [editing, setEditing] = useState<ThemeDefinition | null>(null);

  const customThemes = settings.customThemes ?? [];
  const themeOptions: SelectOption[] = [
    ...BUILTIN_THEME_OPTIONS,
    ...customThemes.map((t) => ({ value: customThemeSetting(t.id), label: t.name })),
  ];

  const selectedCustomId = customThemeId(settings.theme);
  const selectedCustom = selectedCustomId
    ? findCustomTheme(customThemes, selectedCustomId)
    : undefined;

  const openNewTheme = () => {
    const baseId = settings.theme && BUILTIN_BASE_IDS.has(settings.theme) ? settings.theme : "dark";
    const fresh = createCustomTheme(baseId, dedupeThemeName("Custom Theme", customThemes));
    setEditing(fresh);
  };

  const openEditTheme = () => {
    if (!selectedCustom) return;
    // Edit a deep copy so live preview edits never mutate persisted state.
    setEditing({ ...selectedCustom, colors: { ...selectedCustom.colors } });
  };

  const closeEditor = () => {
    setEditing(null);
    // The editor previewed unsaved edits live; restore the persisted theme.
    applyTheme(settings.theme, settings.customThemes);
  };

  const handleSaveTheme = (theme: ThemeDefinition) => {
    const others = customThemes.filter((t) => t.id !== theme.id);
    const saved: ThemeDefinition = { ...theme, name: dedupeThemeName(theme.name, others) };
    const exists = customThemes.some((t) => t.id === theme.id);
    const nextThemes = exists
      ? customThemes.map((t) => (t.id === theme.id ? saved : t))
      : [...customThemes, saved];
    onChange({ ...settings, customThemes: nextThemes, theme: customThemeSetting(saved.id) });
    setEditing(null);
    toast.success(`Theme "${saved.name}" saved`);
  };

  const handleDeleteTheme = () => {
    if (!selectedCustom) return;
    const deleted = selectedCustom;
    const nextThemes = customThemes.filter((t) => t.id !== deleted.id);
    // Fall back to Dark when the theme being deleted is the active one.
    const nextTheme = isCustomThemeSetting(settings.theme) ? "dark" : settings.theme;
    onChange({ ...settings, customThemes: nextThemes, theme: nextTheme });
    toast.success(`Theme "${deleted.name}" deleted`);
  };

  const handleExportTheme = async () => {
    if (!selectedCustom) return;
    try {
      const filePath = await save({
        title: "Export Theme",
        defaultPath: themeFileName(selectedCustom.name),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return; // dialog cancelled
      await writeTextFile(filePath, serializeTheme(selectedCustom));
      toast.success(`Theme "${selectedCustom.name}" exported`);
    } catch (err) {
      toast.error(`Failed to export theme: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleImportTheme = async () => {
    let filePath: string | string[] | null;
    try {
      filePath = await open({
        multiple: false,
        title: "Import Theme",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
    } catch {
      return; // dialog cancelled / unavailable
    }
    if (!filePath || Array.isArray(filePath)) return;

    let text: string;
    try {
      text = await readTextFile(filePath);
    } catch (err) {
      toast.error(`Could not read theme file: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let result: ThemeImportResult;
    try {
      result = parseThemeFile(text);
    } catch (err) {
      toast.error(`Invalid theme file: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Regenerate id-free name collisions with a "(2)" suffix, matching the
    // concept's import-rename behavior, then add and select the new theme.
    const name = dedupeThemeName(result.theme.name, customThemes);
    const imported: ThemeDefinition = { ...result.theme, name };
    onChange({
      ...settings,
      customThemes: [...customThemes, imported],
      theme: customThemeSetting(imported.id),
    });
    if (result.hadInvalidColors) {
      toast.success(`Theme "${name}" imported`, {
        description: "Some colors were invalid and fell back to the base theme's defaults.",
      });
    } else {
      toast.success(`Theme "${name}" imported`);
    }
  };

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Appearance</h3>
      {show("theme") && (
        <>
          <SettingsField label="Theme" hint="Application color theme.">
            <Select
              data-testid="appearance-theme-select"
              value={settings.theme ?? "dark"}
              onChange={(value) => onChange({ ...settings, theme: value as AppSettings["theme"] })}
              options={themeOptions}
            />
          </SettingsField>
          <div className="appearance-settings__theme-actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={openNewTheme}
              data-testid="appearance-theme-new"
            >
              New Theme
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={openEditTheme}
              disabled={!selectedCustom}
              data-testid="appearance-theme-edit"
            >
              Edit
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleImportTheme}
              data-testid="appearance-theme-import"
            >
              Import
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExportTheme}
              disabled={!selectedCustom}
              data-testid="appearance-theme-export"
            >
              Export
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDeleteTheme}
              disabled={!selectedCustom}
              data-testid="appearance-theme-delete"
            >
              Delete
            </Button>
          </div>
        </>
      )}
      {editing && (
        <ThemeEditor
          open={editing !== null}
          initialTheme={editing}
          onSave={handleSaveTheme}
          onCancel={closeEditor}
        />
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
          <NumberInput
            min={8}
            max={32}
            value={settings.fontSize ?? ""}
            onValueChange={(v) => onChange({ ...settings, fontSize: v === "" ? undefined : v })}
          />
        </SettingsField>
      )}
      {show("lineHeight") && (
        <SettingsField
          label="Line Height"
          hint="Terminal line height (0.8–2.0). Use 1.0 for seamless box-drawing characters."
        >
          <NumberInput
            min={0.8}
            max={2.0}
            step={0.1}
            value={settings.lineHeight ?? ""}
            onValueChange={(v) => onChange({ ...settings, lineHeight: v === "" ? undefined : v })}
          />
        </SettingsField>
      )}
    </div>
  );
}
