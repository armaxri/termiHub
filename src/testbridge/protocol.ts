/**
 * In-app test bridge protocol.
 *
 * The test bridge exposes a small, transport-agnostic command vocabulary that an
 * external test runner (or AI coding agent) uses to drive and introspect the
 * running termiHub UI. Unlike WebDriver, the bridge runs *inside* the app, so it
 * works identically on every platform — including macOS, where no WKWebView
 * WebDriver exists (see ADR-5 in docs/architecture.md).
 *
 * Commands are resolved against the live DOM (by `data-testid`), the
 * {@link TerminalRegistry} (for reliable in-memory terminal buffer reads), and
 * the Zustand app store (for state introspection). Every command produces a
 * {@link BridgeResponse} whose shape is deliberately simple so an agent can read
 * the outcome without parsing prose.
 */

/** Click the element carrying the given `data-testid`. */
export interface ClickCommand {
  action: "click";
  testId: string;
}

/**
 * Set the value of an `<input>`/`<textarea>` carrying the given `data-testid`.
 *
 * Uses the native value setter + an `input` event so React's controlled inputs
 * observe the change — the same workaround the E2E helpers use to survive
 * WebKitGTK keyboard-state corruption after terminal sessions.
 */
export interface TypeCommand {
  action: "type";
  testId: string;
  text: string;
}

/**
 * Choose an option of a `<select>` carrying the given `data-testid`.
 *
 * A counterpart to {@link TypeCommand} for native dropdowns (connection type,
 * SSH auth method, theme, …): sets `value` via the native setter and dispatches a
 * `change` event so React's controlled `<select>` observes it. Fails if the
 * element is not a `<select>` or `value` is not one of its options.
 */
export interface SelectCommand {
  action: "select";
  testId: string;
  value: string;
}

/**
 * Open an element's context menu via a synthetic right-click.
 *
 * `click` left-clicks; context menus (Radix `ContextMenu.Trigger`) open on the
 * native `contextmenu` event. This dispatches `pointerdown`/`mousedown` with the
 * secondary button, then `contextmenu`, so the menu opens exactly as a real
 * right-click would.
 */
export interface RightClickCommand {
  action: "rightClick";
  testId: string;
}

/**
 * Press a key (with optional modifiers) as a `keydown` + `keyup` pair.
 *
 * Drives keyboard-only affordances the pointer verbs cannot: dismissing a menu
 * with `Escape`, or triggering an app shortcut. The event is dispatched on the
 * active element (falling back to the document body) and bubbles, so global
 * shortcut handlers on `window`/`document` observe it. `key` is the
 * `KeyboardEvent.key` value (e.g. `"Escape"`, `"a"`, `"Enter"`).
 */
export interface KeyCommand {
  action: "key";
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * Drag one element onto another via synthetic pointer events.
 *
 * For pointer-based drag-and-drop (e.g. @dnd-kit tab reordering): dispatches
 * `pointerdown` on `fromTestId`, a series of `pointermove`s crossing the sensor's
 * activation distance toward `toTestId`'s center, then `pointerup`. Unlike
 * {@link DragCommand} (a blind pixel delta), this targets a destination element.
 */
export interface DragToCommand {
  action: "dragTo";
  fromTestId: string;
  toTestId: string;
}

/**
 * Send input into a running terminal **session** (not a form field).
 *
 * An xterm terminal renders to a canvas, so {@link TypeCommand} cannot drive it.
 * This command routes `text` to the session's backend `send_input` — the same
 * choke point interactive keystrokes use — so line-ending normalization applies.
 * A trailing newline is appended for you (honoring the session's configured line
 * ending, exactly like pressing Enter), so `text: "ls"` runs `ls`. When `tabId`
 * is omitted the active tab's terminal is used.
 */
export interface TerminalInputCommand {
  action: "terminalInput";
  text: string;
  tabId?: string;
}

/** Whether an element with the given `data-testid` currently exists in the DOM. */
export interface ExistsCommand {
  action: "exists";
  testId: string;
}

/** Read the visible text content of the element with the given `data-testid`. */
export interface GetTextCommand {
  action: "getText";
  testId: string;
}

/** Read an arbitrary attribute of the element with the given `data-testid`. */
export interface GetAttributeCommand {
  action: "getAttribute";
  testId: string;
  attribute: string;
}

/**
 * Read a *computed* CSS property of an element — including custom properties.
 *
 * `getAttribute` only sees inline/markup attributes, so it cannot observe the
 * effective `cursor`, a theme color, or a CSS variable resolved from a
 * stylesheet. This command runs `getComputedStyle(el).getPropertyValue(property)`
 * and returns the trimmed value. When `testId` is omitted the document root
 * (`:root` / `documentElement`) is read — the place theme custom properties like
 * `--bg-primary` are defined.
 */
export interface GetComputedStyleCommand {
  action: "getComputedStyle";
  /** Element to read; omit to read the document root (theme CSS variables). */
  testId?: string;
  /** CSS property name, e.g. `"cursor"` or a custom property `"--bg-primary"`. */
  property: string;
}

/**
 * Drag an element by a pixel delta via synthetic mouse events.
 *
 * `click` cannot drive drag-to-resize handles or pointer-based reordering. This
 * command dispatches a `mousedown` on the element followed by `mousemove` and
 * `mouseup` on the document, offset by `(dx, dy)` from the element's center —
 * the exact sequence handlers like `useSidebarResize` listen for (they read
 * `event.clientX`). Only the delta matters, so the caller need not know absolute
 * coordinates.
 */
export interface DragCommand {
  action: "drag";
  testId: string;
  /** Horizontal drag distance in pixels (positive = right). */
  dx: number;
  /** Vertical drag distance in pixels (positive = down); defaults to 0. */
  dy?: number;
}

/**
 * Read the reconstructed text of a terminal's scrollback + viewport.
 *
 * When `tabId` is omitted the active tab's terminal is used. `joinFullWidthRows`
 * rejoins hard wraps at the terminal width (matching "Save to File" behavior).
 */
export interface ReadTerminalCommand {
  action: "readTerminal";
  tabId?: string;
  joinFullWidthRows?: boolean;
}

/**
 * Read a slice of the app store. `path` is an optional dot-path into the state
 * (e.g. `"activePanelId"` or `"rootPanel.activeTabId"`). When omitted, a curated
 * snapshot of serializable state is returned.
 */
export interface GetStateCommand {
  action: "getState";
  path?: string;
}

/** The full set of commands the bridge understands. */
export type BridgeCommand =
  | ClickCommand
  | TypeCommand
  | SelectCommand
  | RightClickCommand
  | KeyCommand
  | TerminalInputCommand
  | ExistsCommand
  | GetTextCommand
  | GetAttributeCommand
  | GetComputedStyleCommand
  | DragCommand
  | DragToCommand
  | ReadTerminalCommand
  | GetStateCommand;

/** The discriminator literal of any {@link BridgeCommand}. */
export type BridgeAction = BridgeCommand["action"];

/**
 * The result of dispatching a {@link BridgeCommand}.
 *
 * `ok` is the single field an agent must check. On success, query commands place
 * their result in `value`; action commands (`click`, `type`, `terminalInput`)
 * return `ok` with no `value`. On failure, `error` carries an agent-readable
 * reason.
 */
export interface BridgeResponse {
  ok: boolean;
  /** Echoes the originating command's action for correlation. */
  action: BridgeAction;
  /** Query result payload (text, boolean, terminal content, state slice). */
  value?: unknown;
  /** Human/agent-readable failure reason; present only when `ok` is false. */
  error?: string;
}
