import { TabContentType, TerminalTab } from "@/types/terminal";
import { ShortcutScope } from "@/types/keybindings";

/**
 * Coarse bucket describing what kind of surface is currently focused, derived
 * from the active tab's content type. Used by the keyboard dispatcher to decide
 * whether a matched action's scope is compatible with the active surface.
 */
export type ActiveContext = "terminal" | "editor" | "form" | "other";

/**
 * Maps every tab content type to its active context. Exhaustive over
 * `TabContentType` so adding a new content type is a compile error here until
 * it is bucketed, preventing silent drift from the {@link TabContentType} union.
 */
const CONTEXT_BY_CONTENT_TYPE: Record<TabContentType, ActiveContext> = {
  terminal: "terminal",
  editor: "editor",
  "connection-editor": "form",
  "tunnel-editor": "form",
  "workspace-editor": "form",
  settings: "form",
  "network-diagnostic": "form",
  // The plugin detail panel is a read-only info surface with action buttons, not
  // a text-editing surface — editor-delegated shortcuts may still fire over it.
  "plugin-detail": "other",
  "log-viewer": "other",
  "agent-error": "other",
  "file-browser": "other",
  // A remote-desktop tab captures keyboard/mouse for the remote, so its own
  // canvas handles input; it is not a termiHub text surface.
  "remote-desktop": "other",
};

/**
 * Derive the active context from the active tab. Read-only tabs and the absence
 * of any active tab map to `"other"`.
 */
export function activeContextFromTab(tab?: TerminalTab): ActiveContext {
  if (!tab) return "other";
  return CONTEXT_BY_CONTENT_TYPE[tab.contentType] ?? "other";
}

/**
 * Whether a keyboard event originated from a focused text-editing surface — a
 * native `<input>`/`<textarea>`, a `contenteditable`, or a Monaco editor.
 *
 * This is a defensive complement to {@link activeContextFromTab}: it catches
 * inputs that live inside modals/portals rather than a distinct tab, so the
 * dispatcher steps aside even when the active tab's content type is not itself
 * an editor or form.
 */
export function isEventFromTextInput(e: KeyboardEvent): boolean {
  const el = (e.target as Element | null) ?? document.activeElement;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest(
    "input, textarea, [contenteditable=''], [contenteditable='true'], .monaco-editor"
  );
}

/**
 * Whether an action with the given `scope` should fire in the given context.
 *
 * - `global` always fires.
 * - `terminal` fires only on a terminal tab when focus is not inside a text input.
 * - `editor-delegated` steps aside (returns `false`) whenever an editor/form is
 *   active or focus is inside a text input; otherwise it may fire.
 */
export function isScopeCompatible(
  scope: ShortcutScope,
  ctx: ActiveContext,
  fromTextInput: boolean
): boolean {
  if (scope === "global") return true;
  if (scope === "terminal") return ctx === "terminal" && !fromTextInput;
  // editor-delegated
  return !(ctx === "editor" || ctx === "form" || fromTextInput);
}
