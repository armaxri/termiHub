import {
  KeyCombo,
  KeyBinding,
  KeybindingOverride,
  KeybindingOverrideEntry,
} from "@/types/keybindings";
import { isMac } from "@/utils/platform";

/** All default keybindings for the application. */
export const DEFAULT_BINDINGS: KeyBinding[] = [
  // General
  {
    action: "toggle-sidebar",
    label: "Toggle Sidebar",
    category: "general",
    macDefault: { key: "b", meta: true },
    winLinuxDefault: { key: "b", ctrl: true },
    configurable: true,
  },
  {
    action: "open-settings",
    label: "Open Settings",
    category: "general",
    macDefault: { key: ",", meta: true },
    winLinuxDefault: { key: ",", ctrl: true },
    configurable: true,
  },
  {
    action: "show-shortcuts",
    label: "Keyboard Shortcuts",
    category: "general",
    macDefault: [
      { key: "k", meta: true },
      { key: "s", meta: true },
    ],
    winLinuxDefault: [
      { key: "k", ctrl: true },
      { key: "s", ctrl: true },
    ],
    configurable: true,
  },

  // Terminal
  {
    action: "new-terminal",
    label: "New Terminal",
    category: "terminal",
    macDefault: { key: "`", meta: true, shift: true },
    winLinuxDefault: { key: "`", ctrl: true, shift: true },
    configurable: true,
  },
  {
    action: "close-tab",
    label: "Close Tab",
    category: "terminal",
    macDefault: { key: "w", meta: true },
    winLinuxDefault: { key: "w", ctrl: true },
    configurable: true,
  },
  {
    action: "next-tab",
    label: "Next Tab",
    category: "terminal",
    macDefault: { key: "Tab", ctrl: true },
    winLinuxDefault: { key: "Tab", ctrl: true },
    configurable: true,
  },
  {
    action: "prev-tab",
    label: "Previous Tab",
    category: "terminal",
    macDefault: { key: "Tab", ctrl: true, shift: true },
    winLinuxDefault: { key: "Tab", ctrl: true, shift: true },
    configurable: true,
  },
  {
    action: "clear-terminal",
    label: "Clear Terminal",
    category: "terminal",
    macDefault: { key: "k", meta: true },
    winLinuxDefault: { key: "K", ctrl: true, shift: true },
    configurable: true,
  },
  {
    action: "find-in-terminal",
    label: "Find in Terminal",
    category: "terminal",
    macDefault: { key: "f", meta: true },
    winLinuxDefault: { key: "F", ctrl: true, shift: true },
    configurable: true,
  },

  // Clipboard
  {
    action: "copy",
    label: "Copy Selection",
    category: "clipboard",
    macDefault: { key: "c", meta: true },
    winLinuxDefault: { key: "C", ctrl: true, shift: true },
    configurable: true,
  },
  {
    action: "paste",
    label: "Paste",
    category: "clipboard",
    macDefault: { key: "v", meta: true },
    winLinuxDefault: { key: "V", ctrl: true, shift: true },
    configurable: true,
  },
  {
    action: "select-all",
    label: "Select All",
    category: "clipboard",
    macDefault: { key: "a", meta: true },
    winLinuxDefault: { key: "A", ctrl: true, shift: true },
    configurable: true,
  },

  // Navigation / Split
  {
    action: "split-right",
    label: "Split Right",
    category: "navigation",
    macDefault: { key: "\\", meta: true },
    winLinuxDefault: { key: "\\", ctrl: true },
    configurable: true,
  },
  {
    action: "focus-next-panel",
    label: "Focus Next Panel",
    category: "navigation",
    macDefault: { key: "ArrowRight", meta: true, alt: true },
    winLinuxDefault: { key: "ArrowRight", ctrl: true, alt: true },
    configurable: true,
  },
  {
    action: "focus-prev-panel",
    label: "Focus Previous Panel",
    category: "navigation",
    macDefault: { key: "ArrowLeft", meta: true, alt: true },
    winLinuxDefault: { key: "ArrowLeft", ctrl: true, alt: true },
    configurable: true,
  },
  {
    action: "zoom-in",
    label: "Zoom In",
    category: "navigation",
    macDefault: { key: "=", meta: true },
    winLinuxDefault: { key: "=", ctrl: true },
    configurable: true,
  },
  {
    action: "zoom-out",
    label: "Zoom Out",
    category: "navigation",
    macDefault: { key: "-", meta: true },
    winLinuxDefault: { key: "-", ctrl: true },
    configurable: true,
  },
  {
    action: "zoom-reset",
    label: "Reset Zoom",
    category: "navigation",
    macDefault: { key: "0", meta: true },
    winLinuxDefault: { key: "0", ctrl: true },
    configurable: true,
  },
];

/** Active user overrides. */
let overrides: KeybindingOverride[] = [];

/** Serialize a KeyCombo to a human-readable string like "Ctrl+Shift+C". */
export function serializeCombo(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push("Alt");
  if (combo.meta) parts.push("Cmd");
  parts.push(normalizeKeyDisplay(combo.key));
  return parts.join("+");
}

/** Serialize a combo or chord sequence to a string. */
export function serializeBinding(combo: KeyCombo | KeyCombo[]): string {
  if (Array.isArray(combo)) {
    return combo.map(serializeCombo).join(" ");
  }
  return serializeCombo(combo);
}

/** Normalize key names for display. */
function normalizeKeyDisplay(key: string): string {
  const MAP: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
  };
  return MAP[key] ?? key;
}

/** Parse a serialized combo string back into a KeyCombo. */
export function parseCombo(str: string): KeyCombo {
  const parts = str.split("+");
  const combo: KeyCombo = { key: "" };

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl") combo.ctrl = true;
    else if (lower === "shift") combo.shift = true;
    else if (lower === "alt") combo.alt = true;
    else if (lower === "cmd" || lower === "meta") combo.meta = true;
    else combo.key = part;
  }

  return combo;
}

/** Parse a serialized binding string (single combo or chord) back into KeyCombo or KeyCombo[]. */
export function parseBinding(str: string): KeyCombo | KeyCombo[] {
  const parts = str.split(" ");
  if (parts.length === 1) {
    return parseCombo(parts[0]);
  }
  return parts.map(parseCombo);
}

/** Check if a KeyboardEvent matches a single KeyCombo. */
export function eventMatchesCombo(event: KeyboardEvent, combo: KeyCombo): boolean {
  if (event.key !== combo.key && event.key.toLowerCase() !== combo.key.toLowerCase()) {
    return false;
  }
  if (!!combo.ctrl !== event.ctrlKey) return false;
  if (!!combo.shift !== event.shiftKey) return false;
  if (!!combo.alt !== event.altKey) return false;
  if (!!combo.meta !== event.metaKey) return false;
  return true;
}

/** Get the effective combo for an action (user override or platform default). */
export function getEffectiveCombo(action: string): KeyCombo | KeyCombo[] | null {
  const override = overrides.find((o) => o.action === action);
  if (override) return override.combo;

  const binding = DEFAULT_BINDINGS.find((b) => b.action === action);
  if (!binding) return null;

  return isMac() ? binding.macDefault : binding.winLinuxDefault;
}

/**
 * Find which action matches a keyboard event (single-combo bindings only).
 * For chord support, use processKeyEvent() instead.
 */
export function findMatchingAction(event: KeyboardEvent): string | null {
  for (const binding of DEFAULT_BINDINGS) {
    const combo = getEffectiveCombo(binding.action);
    if (!combo) continue;

    // Skip chord bindings (arrays with >1 combo)
    if (Array.isArray(combo) && combo.length > 1) continue;

    const single = Array.isArray(combo) ? combo[0] : combo;
    if (eventMatchesCombo(event, single)) {
      return binding.action;
    }
  }
  return null;
}

/** Check if a keyboard event matches any application shortcut (non-terminal). */
export function isAppShortcut(event: KeyboardEvent): boolean {
  return findMatchingAction(event) !== null;
}

/** Set user overrides from persisted settings. */
export function setOverrides(entries: KeybindingOverrideEntry[]): void {
  overrides = entries.map((e) => {
    const parsed = parseBinding(e.key);
    return { action: e.action, combo: parsed };
  });
}

/** Get the current overrides as serialized entries. */
export function getOverrides(): KeybindingOverrideEntry[] {
  return overrides.map((o) => ({
    action: o.action,
    key: serializeBinding(o.combo),
  }));
}

/** Clear all overrides (reset to defaults). */
export function clearOverrides(): void {
  overrides = [];
}

/** Set a single override for an action. Pass null combo to remove the override. */
export function setOverride(action: string, combo: KeyCombo | KeyCombo[] | null): void {
  overrides = overrides.filter((o) => o.action !== action);
  if (combo !== null) {
    overrides.push({ action, combo });
  }
}

/**
 * Check for conflicts: returns the action that already uses the given combo,
 * or null if no conflict exists.
 */
export function checkConflict(combo: KeyCombo, excludeAction?: string): string | null {
  for (const binding of DEFAULT_BINDINGS) {
    if (binding.action === excludeAction) continue;

    const effective = getEffectiveCombo(binding.action);
    if (!effective) continue;

    const single = Array.isArray(effective) ? effective[0] : effective;
    if (!Array.isArray(effective) || effective.length === 1) {
      if (combosEqual(single, combo)) {
        return binding.action;
      }
    }
  }
  return null;
}

/** Check if two combos are equal. */
function combosEqual(a: KeyCombo, b: KeyCombo): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt &&
    !!a.meta === !!b.meta
  );
}

/** Get all default bindings (for display in overlay/settings). */
export function getDefaultBindings(): KeyBinding[] {
  return DEFAULT_BINDINGS;
}

// --- Chord state machine ---

const CHORD_TIMEOUT_MS = 1500;

/** Pending first combo of a chord sequence, or null if not in chord mode. */
let pendingChordCombo: KeyCombo | null = null;
let chordTimerId: ReturnType<typeof setTimeout> | null = null;
let chordStateCallback: ((pending: string | null) => void) | null = null;

/** Register a callback that is invoked when chord pending state changes. */
export function onChordStateChange(cb: (pending: string | null) => void): void {
  chordStateCallback = cb;
}

/** Cancel any pending chord sequence. */
export function cancelChord(): void {
  if (chordTimerId !== null) {
    clearTimeout(chordTimerId);
    chordTimerId = null;
  }
  pendingChordCombo = null;
  chordStateCallback?.(null);
}

/**
 * Process a keyboard event through the chord-aware state machine.
 * Returns the matched action name, or null if no match.
 *
 * - If no chord is pending, first checks single-combo bindings.
 *   If the event matches the first combo of a chord binding, enters chord mode.
 * - If a chord is pending, checks if the event completes any chord binding.
 *   If not, cancels the chord and falls through to single-combo matching.
 */
export function processKeyEvent(event: KeyboardEvent): string | null {
  // If chord pending, try to complete it
  if (pendingChordCombo !== null) {
    const first = pendingChordCombo;
    cancelChord();

    for (const binding of DEFAULT_BINDINGS) {
      const combo = getEffectiveCombo(binding.action);
      if (!combo || !Array.isArray(combo) || combo.length < 2) continue;

      if (combosEqual(first, combo[0]) && eventMatchesCombo(event, combo[1])) {
        return binding.action;
      }
    }

    // Chord didn't complete — fall through to single-combo matching
    return findMatchingAction(event);
  }

  // Check if event starts a chord
  for (const binding of DEFAULT_BINDINGS) {
    const combo = getEffectiveCombo(binding.action);
    if (!combo || !Array.isArray(combo) || combo.length < 2) continue;

    if (eventMatchesCombo(event, combo[0])) {
      pendingChordCombo = combo[0];
      chordStateCallback?.(serializeCombo(combo[0]));

      chordTimerId = setTimeout(() => {
        cancelChord();
      }, CHORD_TIMEOUT_MS);

      return "chord-pending";
    }
  }

  // Regular single-combo matching
  return findMatchingAction(event);
}

/** Check if a chord is currently pending (for testing). */
export function isChordPending(): boolean {
  return pendingChordCombo !== null;
}
