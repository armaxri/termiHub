import { useSyncExternalStore } from "react";
// Imported from the engine module (not the `@/themes` barrel) on purpose: many
// component tests stub the barrel with only `applyTheme`/`onThemeChange`, and
// connection icons render inside nearly every one of them.
import { getCurrentTheme, getThemeRevision, onThemeChange } from "@/themes/engine";
import { iconSurfaces } from "@/utils/connectionIconStyle";

/**
 * The active theme's icon surfaces (sidebar + tab backgrounds) that a tinted
 * connection icon must contrast with (#5008). Re-renders on every theme
 * (re-)apply so palette colours switch shade live.
 */
export function useIconSurfaces(): string[] {
  useSyncExternalStore(onThemeChange, getThemeRevision);
  return iconSurfaces(getCurrentTheme().colors);
}
