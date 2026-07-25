import { getDefaultBindings, getActionAccelerator } from "@/services/keybindings";
import { useAppStore } from "@/store/appStore";
import { CONTEXT_COMMANDS, ContextCommand } from "@/services/contextCommands";

/**
 * A runnable application command surfaced in the command palette (#1484, #1527).
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
  /**
   * Whether the command can run against the current context. Store-only
   * commands are always available; context-bound commands (focus-panel, tab
   * close/next/prev, terminal find/clear) are unavailable when there is no
   * applicable target, and the palette disables them with a clear affordance.
   */
  available: boolean;
  /** Execute the command. */
  run: () => void;
}

/**
 * Store-only runners: actions that operate purely on global store state and are
 * always available. Context-bound actions (which need live panel/terminal
 * resolution) live in {@link CONTEXT_COMMANDS} instead, so the palette and the
 * keyboard handler share one implementation and one availability check.
 */
const STORE_RUNNERS: Record<string, () => void> = {
  "toggle-sidebar": () => useAppStore.getState().toggleSidebar(),
  "open-settings": () => useAppStore.getState().openSettingsTab(),
  "show-shortcuts": () => useAppStore.getState().setShortcutsOverlayOpen(true),
  "new-terminal": () => {
    useAppStore.getState().addTab("Terminal", "local");
  },
  "new-window": () => {
    void useAppStore.getState().openNewWindow();
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
  "toggle-macro-recording": () => useAppStore.getState().toggleMacroRecording(),
  "toggle-broadcast": () => useAppStore.getState().toggleBroadcast(),
};

/**
 * Resolve the runner for a keybinding action, or `undefined` when the action is
 * not surfaced in the palette. Store-only runners are wrapped so every runner
 * exposes the same `{ run, isAvailable? }` shape.
 */
function getRunner(action: string): ContextCommand | undefined {
  if (action in CONTEXT_COMMANDS) return CONTEXT_COMMANDS[action];
  if (action in STORE_RUNNERS) return { run: STORE_RUNNERS[action], isAvailable: () => true };
  return undefined;
}

/**
 * Build the list of runnable commands for the command palette, in the order
 * their bindings are declared. Labels and accelerators come from the keybinding
 * service so the palette stays in sync with the shortcuts overlay and any user
 * overrides. Availability is resolved against live context at call time, so
 * callers rebuild whenever the focused panel/terminal changes.
 */
export function buildCommands(): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  for (const binding of getDefaultBindings()) {
    const runner = getRunner(binding.action);
    if (!runner) continue;
    commands.push({
      id: binding.action,
      label: binding.label,
      accelerator: getActionAccelerator(binding.action),
      available: runner.isAvailable(),
      run: runner.run,
    });
  }
  return commands;
}
