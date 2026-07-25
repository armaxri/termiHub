import {
  KeyCombo,
  KeyBinding,
  KeybindingOverride,
  KeybindingOverrideEntry,
  ShortcutScope,
} from "@/types/keybindings";
import { isMac } from "@/utils/platform";

/**
 * All default keybindings for the application.
 *
 * Windows/Linux defaults deliberately avoid common shell, tmux, and readline
 * shortcuts so that termiHub does not silently intercept keystrokes the user
 * intended for the terminal (locally or via SSH). The macOS defaults use the
 * Cmd modifier, which does not collide with shell keybindings, so they keep
 * the more conventional single-modifier form.
 */
export const DEFAULT_BINDINGS: KeyBinding[] = [
  // General
  {
    action: "toggle-sidebar",
    label: "Toggle Sidebar",
    category: "general",
    macDefault: { key: "b", meta: true },
    // Avoid Ctrl+B: tmux default prefix key.
    winLinuxDefault: { key: "B", ctrl: true, shift: true },
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
    action: "command-palette",
    label: "Command Palette",
    category: "general",
    macDefault: { key: "p", meta: true },
    // Avoid bare Ctrl+P: readline "previous-history". Ctrl+Shift+P matches the
    // familiar VS Code command-palette shortcut and does not collide with the
    // shell key map.
    winLinuxDefault: { key: "P", ctrl: true, shift: true },
    configurable: true,
  },
  {
    action: "new-window",
    label: "New Window",
    category: "general",
    // Opens a new empty native window (#1902). Ctrl/Cmd+Shift+N does not collide
    // with the shell key map and mirrors the familiar "new window" convention.
    macDefault: { key: "N", meta: true, shift: true },
    winLinuxDefault: { key: "N", ctrl: true, shift: true },
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
    // Avoid Ctrl+K chord leader: readline "kill-to-end-of-line". F1 is unbound
    // in virtually every shell and is the long-standing "help" affordance.
    winLinuxDefault: { key: "F1" },
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
    // Avoid Ctrl+W: readline "delete-word-backward" and vim window-command prefix.
    winLinuxDefault: { key: "W", ctrl: true, shift: true },
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
    macDefault: { key: "K", meta: true, shift: true },
    winLinuxDefault: { key: "K", ctrl: true, shift: true },
    configurable: true,
    scope: "terminal",
  },
  {
    action: "find-in-terminal",
    label: "Find in Terminal",
    category: "terminal",
    macDefault: { key: "f", meta: true },
    winLinuxDefault: { key: "F", ctrl: true, shift: true },
    configurable: true,
    scope: "terminal",
  },
  {
    action: "move-tab-to-new-window",
    label: "Move Tab to New Window",
    category: "terminal",
    // Ships unbound: the primary surface is the tab context menu (#1901); this
    // entry exists so the action is command-palette reachable.
    macDefault: null,
    winLinuxDefault: null,
    configurable: true,
  },
  {
    action: "toggle-macro-recording",
    label: "Record Macro (Start/Stop)",
    category: "terminal",
    // Ships unbound to avoid colliding with shell/tmux/vim keys; the user can
    // assign a binding in Settings. Reachable now via the toolbar button and the
    // command palette.
    macDefault: null,
    winLinuxDefault: null,
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
    scope: "editor-delegated",
  },
  {
    action: "paste",
    label: "Paste",
    category: "clipboard",
    macDefault: { key: "v", meta: true },
    winLinuxDefault: { key: "V", ctrl: true, shift: true },
    configurable: true,
    scope: "editor-delegated",
  },
  {
    action: "select-all",
    label: "Select All",
    category: "clipboard",
    macDefault: { key: "a", meta: true },
    winLinuxDefault: { key: "A", ctrl: true, shift: true },
    configurable: true,
    scope: "editor-delegated",
  },

  // Navigation / Split
  {
    action: "split-right",
    label: "Split Right",
    category: "navigation",
    macDefault: { key: "\\", meta: true },
    // Avoid Ctrl+\: sends SIGQUIT (force-kill) to foreground process.
    winLinuxDefault: { key: "\\", alt: true, shift: true },
    configurable: true,
  },
  {
    action: "split-down",
    label: "Split Down",
    category: "navigation",
    macDefault: { key: "\\", meta: true, shift: true },
    // Sibling to split-right; "-" reads as a horizontal divider for a downward split.
    winLinuxDefault: { key: "-", alt: true, shift: true },
    configurable: true,
  },
  {
    action: "focus-up",
    label: "Focus Panel Above",
    category: "navigation",
    macDefault: { key: "ArrowUp", meta: true, alt: true },
    // Avoid Ctrl+Alt+Arrow: GNOME/KDE workspace switching and Intel-driver screen rotation.
    winLinuxDefault: { key: "ArrowUp", alt: true, shift: true },
    configurable: true,
  },
  {
    action: "focus-down",
    label: "Focus Panel Below",
    category: "navigation",
    macDefault: { key: "ArrowDown", meta: true, alt: true },
    winLinuxDefault: { key: "ArrowDown", alt: true, shift: true },
    configurable: true,
  },
  {
    action: "focus-left",
    label: "Focus Panel Left",
    category: "navigation",
    macDefault: { key: "ArrowLeft", meta: true, alt: true },
    winLinuxDefault: { key: "ArrowLeft", alt: true, shift: true },
    configurable: true,
  },
  {
    action: "focus-right",
    label: "Focus Panel Right",
    category: "navigation",
    macDefault: { key: "ArrowRight", meta: true, alt: true },
    winLinuxDefault: { key: "ArrowRight", alt: true, shift: true },
    configurable: true,
  },
  {
    action: "zoom-panel",
    label: "Toggle Panel Zoom",
    category: "navigation",
    macDefault: { key: "Enter", meta: true, shift: true },
    winLinuxDefault: { key: "Enter", ctrl: true, shift: true },
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

  // Tab Groups
  {
    action: "new-tab-group",
    label: "New Tab Group",
    category: "tab-groups",
    macDefault: { key: "t", meta: true, shift: true },
    winLinuxDefault: { key: "t", ctrl: true, shift: true },
    configurable: true,
  },
  {
    action: "close-tab-group",
    label: "Close Tab Group",
    category: "tab-groups",
    macDefault: { key: "w", meta: true, shift: true },
    // Ctrl+Shift+W is now Close Tab on Win/Linux — relocate Close Tab Group to Ctrl+Shift+Q.
    winLinuxDefault: { key: "Q", ctrl: true, shift: true },
    configurable: true,
  },
  {
    action: "next-tab-group",
    label: "Next Tab Group",
    category: "tab-groups",
    macDefault: { key: "]", meta: true, shift: true },
    winLinuxDefault: { key: "]", ctrl: true, shift: true },
    configurable: true,
  },
  {
    action: "prev-tab-group",
    label: "Previous Tab Group",
    category: "tab-groups",
    macDefault: { key: "[", meta: true, shift: true },
    winLinuxDefault: { key: "[", ctrl: true, shift: true },
    configurable: true,
  },
];

/** Active user overrides. */
let overrides: KeybindingOverride[] = [];

/**
 * Sentinel combo that marks an action as explicitly unbound by the user.
 *
 * Unbinding is stored as an override with an empty key so the action does not
 * fall back to its platform default — that fallback is exactly what the user is
 * opting out of. It round-trips through serialization as an empty string.
 */
export const UNBOUND_COMBO: KeyCombo = { key: "" };

/**
 * Whether a resolved combo represents an explicit "unbound" state — an empty
 * key with no meaningful modifiers. An unbound override is deliberately kept
 * (rather than removed) so the action stays cleared instead of reverting to its
 * platform default on the next launch.
 */
export function isUnboundCombo(combo: KeyCombo | KeyCombo[] | null | undefined): boolean {
  if (!combo) return false;
  if (Array.isArray(combo)) {
    return combo.length === 0 || combo.every((c) => c.key === "");
  }
  return combo.key === "";
}

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

/**
 * Map of keys produced by holding Shift to their unshifted base key.
 * Used so that e.g. Cmd+Shift+= (producing "+") matches a binding for "=".
 */
const SHIFT_KEY_TO_BASE: Record<string, string> = {
  "+": "=",
  _: "-",
};

/** Check if a KeyboardEvent matches a single KeyCombo. */
export function eventMatchesCombo(event: KeyboardEvent, combo: KeyCombo): boolean {
  const keyMatches = event.key === combo.key || event.key.toLowerCase() === combo.key.toLowerCase();

  if (keyMatches) {
    if (!!combo.ctrl !== event.ctrlKey) return false;
    if (!!combo.shift !== event.shiftKey) return false;
    if (!!combo.alt !== event.altKey) return false;
    if (!!combo.meta !== event.metaKey) return false;
    return true;
  }

  // Check shift-equivalence: if the event key is a shifted variant of the combo key,
  // accept the match with shift allowed even if the combo doesn't require it.
  if (event.shiftKey && !combo.shift) {
    const baseKey = SHIFT_KEY_TO_BASE[event.key];
    if (baseKey && baseKey.toLowerCase() === combo.key.toLowerCase()) {
      if (!!combo.ctrl !== event.ctrlKey) return false;
      if (!!combo.alt !== event.altKey) return false;
      if (!!combo.meta !== event.metaKey) return false;
      return true;
    }
  }

  return false;
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

    // Skip actions the user explicitly unbound: they must not fire, and must
    // not fall back to their platform default.
    if (isUnboundCombo(combo)) continue;

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
 * Explicitly unbind an action so it has no shortcut. Stored as an override (not
 * a removal) so the action stays cleared and does not revert to its platform
 * default. Reset-to-default (via {@link setOverride} with `null`) restores it.
 */
export function unbindAction(action: string): void {
  setOverride(action, { ...UNBOUND_COMBO });
}

/** Whether an action is currently unbound (either by default or by the user). */
export function isActionUnbound(action: string): boolean {
  return isUnboundCombo(getEffectiveCombo(action));
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
    if (isUnboundCombo(effective)) continue;

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

/**
 * Get the human-readable accelerator string for an action (e.g. `"Cmd+,"` or
 * `"F1"`), reflecting the effective binding — user override or platform default.
 * Returns `null` when the action has no binding. This is the single source of
 * truth for rendering accelerators inline (e.g. on menu rows), so it stays in
 * sync with what the shortcuts overlay displays.
 */
export function getActionAccelerator(action: string): string | null {
  const combo = getEffectiveCombo(action);
  return combo ? serializeBinding(combo) : null;
}

/**
 * Get the scope of an action — where it is allowed to fire relative to the
 * active tab. Unknown or unannotated actions default to `"global"` so existing
 * behavior is preserved.
 */
export function getActionScope(action: string): ShortcutScope {
  return DEFAULT_BINDINGS.find((b) => b.action === action)?.scope ?? "global";
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

// --- Terminal pass-through ---

/**
 * Whether a key event should be passed through to the focused terminal instead
 * of being matched as an application shortcut. This protects shell/readline,
 * tmux, vim, and SSH-to-remote workflows from accidental interception when a
 * user (or a custom override) binds an action to a key the shell already owns.
 *
 * Covered:
 * - `Ctrl+<single letter>` — readline / emacs / tmux / vim ranges
 * - `Ctrl+\` (SIGQUIT), `Ctrl+[` (Esc), `Ctrl+]` (telnet/screen escape)
 * - `Alt+<single letter>` — readline word-motion commands (Alt+b, Alt+f, …)
 *
 * Not covered: combos that include Shift, Meta/Cmd, or Tab/Arrow keys, since
 * those do not collide with the standard shell key map.
 */
export function isShellReservedKey(event: KeyboardEvent): boolean {
  if (event.metaKey) return false;
  if (event.shiftKey) return false;

  if (event.ctrlKey && !event.altKey) {
    if (event.key.length === 1) {
      if (/^[a-zA-Z]$/.test(event.key)) return true;
      if (event.key === "\\" || event.key === "[" || event.key === "]") return true;
    }
    return false;
  }

  if (event.altKey && !event.ctrlKey) {
    if (event.key.length === 1 && /^[a-zA-Z]$/.test(event.key)) return true;
    return false;
  }

  return false;
}

/**
 * Whether the given keyboard event originated from a focused xterm instance.
 * Used together with `isShellReservedKey` to decide whether to pass the key
 * through to the terminal instead of dispatching an application shortcut.
 */
export function isEventFromTerminal(event: KeyboardEvent): boolean {
  const target = event.target as Element | null;
  if (target && typeof target.closest === "function") {
    if (target.closest(".xterm")) return true;
  }
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (active && typeof active.closest === "function") {
    return !!active.closest(".xterm");
  }
  return false;
}
