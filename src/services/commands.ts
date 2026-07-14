import { getDefaultBindings, getActionAccelerator } from "@/services/keybindings";
import { useAppStore } from "@/store/appStore";

/**
 * A runnable application command surfaced in the command palette (#1484).
 *
 * Commands are sourced from the existing keybinding actions
 * ({@link getDefaultBindings}) so their label and accelerator have a single
 * source of truth — the palette never duplicates accelerator strings.
 */
export interface PaletteCommand {
  /** The keybinding action id (e.g. `"new-terminal"`). */
  id: string;
  /** Human-readable label from the action's binding. */
  label: string;
  /** Effective accelerator string (user override or platform default), or null. */
  accelerator: string | null;
  /** Execute the command. */
  run: () => void;
}

/**
 * Runner for each palette-runnable action. An action is surfaced in the palette
 * only when it has an entry here, so context-bound actions that need live panel
 * state (focus-panel, close-tab, next/prev-tab, terminal find/clear) are
 * intentionally omitted — they stay keyboard-only until they can run without a
 * DOM/panel lookup. Everything here operates purely on store state.
 */
const COMMAND_RUNNERS: Record<string, () => void> = {
  "toggle-sidebar": () => useAppStore.getState().toggleSidebar(),
  "open-settings": () => useAppStore.getState().openSettingsTab(),
  "show-shortcuts": () => useAppStore.getState().setShortcutsOverlayOpen(true),
  "new-terminal": () => {
    useAppStore.getState().addTab("Terminal", "local");
  },
  "split-right": () => useAppStore.getState().splitPanel("horizontal"),
  "split-down": () => useAppStore.getState().splitPanel("vertical"),
  "zoom-panel": () => useAppStore.getState().toggleZoomActiveTab(),
  "zoom-in": () => useAppStore.getState().zoomIn(),
  "zoom-out": () => useAppStore.getState().zoomOut(),
  "zoom-reset": () => useAppStore.getState().zoomReset(),
  "new-tab-group": () => {
    useAppStore.getState().addTabGroup();
  },
};

/**
 * Build the list of runnable commands for the command palette, in the order
 * their bindings are declared. Labels and accelerators come from the keybinding
 * service so the palette stays in sync with the shortcuts overlay and any user
 * overrides.
 */
export function buildCommands(): PaletteCommand[] {
  return getDefaultBindings()
    .filter((binding) => binding.action in COMMAND_RUNNERS)
    .map((binding) => ({
      id: binding.action,
      label: binding.label,
      accelerator: getActionAccelerator(binding.action),
      run: COMMAND_RUNNERS[binding.action],
    }));
}
