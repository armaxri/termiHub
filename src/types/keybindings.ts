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

/** A default keybinding definition with platform-specific defaults. */
export interface KeyBinding {
  /** Unique action identifier (e.g., "toggle-sidebar"). */
  action: string;
  /** Human-readable label. */
  label: string;
  /** Group for display in overlay/settings. */
  category: ShortcutCategory;
  /** Default key combo for macOS. */
  macDefault: KeyCombo | KeyCombo[];
  /** Default key combo for Windows/Linux. */
  winLinuxDefault: KeyCombo | KeyCombo[];
  /** Whether the user can rebind this shortcut. */
  configurable: boolean;
}

/** A user override for a keybinding. */
export interface KeybindingOverride {
  action: string;
  combo: KeyCombo | KeyCombo[];
}

/** Serialized form of a keybinding override for storage in AppSettings. */
export interface KeybindingOverrideEntry {
  action: string;
  /** Serialized combo string, e.g., "Ctrl+Shift+C" or "Ctrl+K Ctrl+S" for chords. */
  key: string;
}
