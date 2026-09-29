// Generated from the Rust `KeybindingOverrideEntry`
// (`src-tauri/src/connection/settings.rs`) via ts-rs (audit DUP-030, #3088).
export type { KeybindingOverrideEntry } from "./generated/KeybindingOverrideEntry";

/** A single key combination (e.g., Ctrl+Shift+C). */
export interface KeyCombo {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** Categories for grouping shortcuts in the overlay and settings. */
export type ShortcutCategory = "general" | "clipboard" | "terminal" | "navigation" | "tab-groups";

/**
 * Where an action is allowed to fire, relative to the active tab's content.
 *
 * - `global` — fires regardless of which tab is active (new terminal, split,
 *   zoom, switch tab, settings, sidebar, …). This is the default when omitted.
 * - `terminal` — fires only when the active tab is a terminal (find/clear).
 * - `editor-delegated` — when an editor or input surface is focused the global
 *   handler steps aside so the focused widget receives the key (copy, paste,
 *   select-all, …); it may still fire in non-editor contexts.
 */
export type ShortcutScope = "global" | "terminal" | "editor-delegated";

/** A default keybinding definition with platform-specific defaults. */
export interface KeyBinding {
  /** Unique action identifier (e.g., "toggle-sidebar"). */
  action: string;
  /** Human-readable label. */
  label: string;
  /** Group for display in overlay/settings. */
  category: ShortcutCategory;
  /** Default key combo for macOS. `null` means the action ships unbound. */
  macDefault: KeyCombo | KeyCombo[] | null;
  /** Default key combo for Windows/Linux. `null` means the action ships unbound. */
  winLinuxDefault: KeyCombo | KeyCombo[] | null;
  /** Whether the user can rebind this shortcut. */
  configurable: boolean;
  /**
   * Where this action is allowed to fire, relative to the active tab.
   * Defaults to `"global"` when omitted.
   */
  scope?: ShortcutScope;
}

/** A user override for a keybinding. */
export interface KeybindingOverride {
  action: string;
  combo: KeyCombo | KeyCombo[];
}
