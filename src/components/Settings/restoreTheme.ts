import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import type { ThemeDefinition } from "@/themes";
import type { AppSettings } from "@/types/connection";

type ThemeSelection = AppSettings["theme"];

/**
 * Undo a custom-theme delete (#5158): put `theme` back at its original
 * position and, when the theme selection is still the fallback the delete
 * chose, re-select the theme it had before. Reads the latest settings, so an
 * unrelated edit made inside the undo window is kept; the Settings screen may
 * be closed by the time Undo is pressed, so this persists through the store.
 */
export function restoreTheme(
  theme: ThemeDefinition,
  index: number,
  previousSelection: ThemeSelection,
  fallbackSelection: ThemeSelection
): void {
  const current = currentSettingsView();
  const themes = (current.customThemes ?? []).filter((t) => t.id !== theme.id);
  const at = index < 0 ? themes.length : Math.min(index, themes.length);
  themes.splice(at, 0, theme);
  const selection = current.theme === fallbackSelection ? previousSelection : current.theme;
  void useAppStore
    .getState()
    .updateSettings({ ...current, customThemes: themes, theme: selection });
}
