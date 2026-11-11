import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import { setOverrides } from "@/services/keybindings";
import type { KeybindingOverrideEntry } from "@/types/keybindings";

/**
 * Undo a keybinding reset or import (#5375): put back exactly the overrides
 * that were in effect before it. Reads the latest settings, so an unrelated
 * edit made inside the undo window is kept; the Settings screen may be closed
 * by the time Undo is pressed, so this persists through the store.
 */
export function restoreKeybindings(snapshot: KeybindingOverrideEntry[]): void {
  setOverrides(snapshot);
  void useAppStore.getState().updateSettings({
    ...currentSettingsView(),
    keybindingOverrides: snapshot.length > 0 ? snapshot : undefined,
  });
}

/** "1 custom binding" / "3 custom bindings". */
export function customBindingCount(n: number): string {
  return `${n} custom binding${n === 1 ? "" : "s"}`;
}
