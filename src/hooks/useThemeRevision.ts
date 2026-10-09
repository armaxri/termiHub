import { useSyncExternalStore } from "react";
import { getThemeRevision, onThemeChange } from "@/themes";

/**
 * Subscribe to the theme engine's revision counter. The returned number changes
 * every time a theme is (re-)applied — a settings switch, a custom-theme save,
 * a workspace override, a theme-editor preview, or an OS color-scheme change in
 * "system" mode. Use it as an effect/memo dependency for anything that bakes
 * resolved theme colours somewhere CSS variables cannot reach, such as a
 * `<canvas>` (UI2-004).
 */
export function useThemeRevision(): number {
  return useSyncExternalStore(onThemeChange, getThemeRevision);
}
