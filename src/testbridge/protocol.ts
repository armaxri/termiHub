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
 * Double-click the element carrying the given `data-testid`.
 *
 * Many "activate" gestures are only reachable via a real double-click and a
 * single {@link ClickCommand} never triggers them: connecting a saved connection
 * from the sidebar (`ConnectionList`'s `onDoubleClick` — the only path that
 * raises the SSH key-passphrase prompt), entering a directory in the file
 * browser, and opening a file in the editor. This dispatches the full sequence a
 * real double-click produces: two pointer→mouse→click rounds followed by a
 * `dblclick` event (which React's `onDoubleClick` listens for).
 */
export interface DoubleClickCommand {
  action: "doubleClick";
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
 * Drag one element onto another via synthetic pointer events.
 *
 * For pointer-based drag-and-drop (e.g. @dnd-kit tab reordering): dispatches
 * `pointerdown` on `fromTestId`, a short "wake" `pointermove` past the sensor's
 * activation distance, then a series of `pointermove`s toward `toTestId`'s
 * center, then `pointerup`. A frame is yielded after activation and between
 * moves so @dnd-kit can measure droppable rects and recompute the drop target
 * (`over`) — without those yields the drop reorders nothing. Unlike
 * {@link DragCommand} (a blind pixel delta), this targets a destination element.
 *
 * `toTestId` may be a **drag-only** target — e.g. the `PanelDropZone` edge/center
 * overlays (#2583), which mount only while a drag is active. When it is absent at
 * `pointerdown`, the gesture presses and wakes the sensor first, then resolves the
 * now-mounted target before stepping to it.
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
 * Read the live *value* of an `<input>`, `<textarea>`, or `<select>`.
 *
 * Counterpart to {@link GetAttributeCommand}: a React-**controlled** field
 * updates the DOM *property* `.value`, not the markup `value` attribute, so
 * `getAttribute` reads the stale initial value. This returns `el.value` — what
 * the user/code actually set. Fails for elements without a value property or a
 * missing testid.
 */
export interface GetValueCommand {
  action: "getValue";
  testId: string;
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
 * Open the context menu of the element carrying the given `data-testid`.
 *
 * A left {@link ClickCommand} cannot reach right-click menus, so this dispatches a
 * bubbling `contextmenu` mouse event at the element's center — the same gesture a
 * real right-click produces. Radix's `ContextMenu` (and the native handler) opens
 * the menu, whose items carry their own stable `data-testid`s to click next.
 */
export interface ContextMenuCommand {
  action: "contextMenu";
  testId: string;
}

/**
 * Resize the application window to `width` × `height` logical pixels.
 *
 * The bridge runs inside the webview, so it drives the real Tauri window via
 * `getCurrentWindow().setSize(...)` — the only way to exercise resize-driven
 * behavior (xterm's fit addon re-fits the terminal and re-sizes the PTY when its
 * container resizes). Unlike the DOM-only verbs, this resolves against an
 * injected `resizeWindow` dep, so the live {@link TestBridge} wires the Tauri
 * call while unit tests supply a stub.
 */
export interface ResizeWindowCommand {
  action: "resizeWindow";
  /** Target inner width in logical pixels. */
  width: number;
  /** Target inner height in logical pixels. */
  height: number;
}

/**
 * Dispatch a keyboard key press (`keydown` + `keyup`).
 *
 * Targets the element with `testId` when given, else the focused element — so a
 * bare `pressKey("Escape")` dismisses an open menu/dialog via the document-level
 * key handlers (e.g. Radix's dismiss layer). `key` is a DOM key value such as
 * `"Escape"`, `"Enter"`, `"Tab"`, `"ArrowDown"`.
 */
export interface PressKeyCommand {
  action: "pressKey";
  key: string;
  testId?: string;
  /** Hold Ctrl during the press (e.g. `Ctrl+S`, `Ctrl+End`). */
  ctrl?: boolean;
  /** Hold Meta/Command during the press. */
  meta?: boolean;
  /** Hold Shift during the press. */
  shift?: boolean;
  /** Hold Alt/Option during the press. */
  alt?: boolean;
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
 * Scroll a terminal's viewport by a number of logical lines (or to the bottom).
 *
 * An xterm terminal renders to a canvas with no scrollable DOM box, so neither
 * `click` nor a synthetic wheel event reliably moves its viewport. This routes
 * through xterm's own `scrollLines`/`scrollToBottom`, firing the same `onScroll`
 * event a mouse wheel would — which is what the terminal's auto-scroll guard
 * (#504) keys off to decide whether new output sticks to the bottom. `lines` is
 * signed: negative scrolls up (into scrollback), positive scrolls down. When
 * `toBottom` is true `lines` is ignored and the viewport jumps to the bottom.
 * When `tabId` is omitted the active tab's terminal is used.
 */
export interface ScrollTerminalCommand {
  action: "scrollTerminal";
  /** Signed line delta (negative = up into scrollback); ignored when `toBottom`. */
  lines?: number;
  /** Jump straight to the bottom (resumes auto-scroll), ignoring `lines`. */
  toBottom?: boolean;
  tabId?: string;
}

/**
 * Read a terminal's viewport scroll position: `{ viewportY, baseY }`.
 *
 * `viewportY` is the buffer line at the top of the visible area; `baseY` is the
 * top line when scrolled fully to the bottom. `viewportY < baseY` means the user
 * has scrolled up into the scrollback (auto-scroll suppressed); `viewportY ===
 * baseY` means pinned to the bottom. Lets a test assert auto-scroll behavior
 * without scraping the GPU canvas. When `tabId` is omitted the active tab is used.
 */
export interface GetTerminalViewportCommand {
  action: "getTerminalViewport";
  tabId?: string;
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

/**
 * Capture a PNG screenshot of the rendered app, returned as a data URL.
 *
 * Some carve-outs are manual only because the in-webview bridge can't *see* the
 * rendered UI (pixel geometry, theme rendering). This rasterizes the live DOM to
 * a `data:image/png;base64,…` string, so a test can attach visual evidence and
 * the failure-artifact bundle can include a snapshot of the moment a test failed.
 * Like {@link ResizeWindowCommand} it resolves against an injected `screenshot`
 * dep, so the live {@link TestBridge} wires the real rasterizer while unit tests
 * supply a stub. The DOM-rasterization path does **not** capture the xterm GPU
 * canvas or native OS dialogs — terminal content is read via
 * {@link ReadTerminalCommand} instead.
 */
export interface ScreenshotCommand {
  action: "screenshot";
}

/**
 * Emit a Tauri event into the running app — the bridge's only non-DOM injector.
 *
 * Every other verb drives the UI from the outside (DOM events, terminal input),
 * so UI that is reachable *only* via a backend-originated event cannot be tested
 * at all. The deferred-update banner is the motivating case (#1520): it renders
 * from the `agentUpdates` store slice, which is fed exclusively by the
 * `agent-update-available` event an agent's 24h update timer raises — not
 * replayed on attach, so no amount of clicking surfaces it.
 *
 * This dispatches `event` with `payload` through the same Tauri event bus the
 * backend emits on, so the app's real `listen` subscriptions and store-folding
 * hooks run untouched — the test injects the *stimulus*, not the state. Prefer
 * it over reaching into the store: the app's own event handling stays covered.
 *
 * **Test-mode only.** Like every bridge verb this is reachable only while the
 * bridge is installed ({@link isTestBridgeEnabled}); the live {@link TestBridge}
 * additionally re-checks test mode before touching the bus, because this is the
 * one verb whose blast radius reaches the backend. Unit tests inject a stub via
 * the `emitEvent` dep.
 */
export interface EmitEventCommand {
  action: "emitEvent";
  /** Tauri event name, e.g. `"agent-update-available"`. */
  event: string;
  /** Event payload, serialized as-is; omit for a payload-less event. */
  payload?: unknown;
}

/**
 * Attach to a projection-substrate region (#2149) and start recording its
 * pushed frames — the app-side of the projection-assertion harness (#2164).
 *
 * The substrate's diff frames ride a per-region Tauri IPC channel, invisible to
 * the DOM- and store-facing verbs; this subscribes through the real transport +
 * {@link import("@/services/transport").ProjectionClient} cache and buffers every
 * raw frame so the synchronous Python harness can poll and assert them. Returns
 * `{ subscriptionId, region, snapshot, frames, cache, dropRemaining }` — the id
 * is passed to the other `projection*` verbs. Resolves against an injected
 * `projection` dep, so unit tests supply a fake transport-backed recorder.
 */
export interface ProjectionSubscribeCommand {
  action: "projectionSubscribe";
  region: string;
}

/**
 * Dispatch an intent over the substrate's channel-1 (`intent_dispatch`),
 * returning the {@link import("@/services/transport").IntentAck} receipt.
 *
 * The result of an accepted intent is never inline — it arrives as a diff frame
 * on the affected region, recorded against any active
 * {@link ProjectionSubscribeCommand}. `intentId` / `clientId` are minted when
 * omitted.
 */
export interface ProjectionDispatchCommand {
  action: "projectionDispatch";
  /** Dotted `<domain>.<action>`, e.g. `"diag.increment"`. */
  kind: string;
  /** Kind-specific payload; defaults to `{}`. */
  payload?: unknown;
  intentId?: string;
  clientId?: string;
}

/**
 * Abruptly sever a connected agent's transport in-process (test-bridge only,
 * #2573) to drive the agent-reconnect UI grade (#2574).
 *
 * The bridge has no generic "invoke a Tauri command" verb by design, so the one
 * test-only sever primitive needed by the automated reconnect grade is exposed
 * as its own named verb — mirroring {@link EmitEventCommand}, the only other verb
 * whose blast radius reaches the backend. It calls the `test_sever_agent_transport`
 * Tauri command, which itself refuses unless the app was launched with the test
 * bridge enabled (`TERMIHUB_TEST_BRIDGE_PORT`), so a production launch can never
 * reach the sever. Unlike a clean `disconnect_agent` (user-cancel), the agent's
 * I/O task stays alive and takes the reconnect path, re-attaching any surviving
 * daemon sessions — exactly what a real transport drop produces.
 *
 * Returns `true` when a live agent received the sever, `false` for an unknown or
 * already-dead agent. Resolves against an injected `severAgentTransport` dep, so
 * unit tests supply a stub and the verb fails with a clear "not available" error
 * outside the harness.
 */
export interface SeverAgentTransportCommand {
  action: "severAgentTransport";
  /** Id of the connected agent whose transport to sever. */
  agentId: string;
}

/** Read a subscription's current recorded frames + cache state by id. */
export interface ProjectionStateCommand {
  action: "projectionState";
  subscriptionId: string;
}

/**
 * Schedule the next `count` delivered diffs on a subscription to be dropped
 * before they reach its cache — the forced-gap control. The dropped diffs are
 * still recorded, so the next diff trips the real gap → resync re-baseline.
 */
export interface ProjectionDropNextCommand {
  action: "projectionDropNext";
  subscriptionId: string;
  count: number;
}

/** Re-baseline a subscription's cache from the backend; returns its new state. */
export interface ProjectionResyncCommand {
  action: "projectionResync";
  subscriptionId: string;
}

/** Detach one projection subscription (idempotent). */
export interface ProjectionUnsubscribeCommand {
  action: "projectionUnsubscribe";
  subscriptionId: string;
}

/** A terminal viewport scroll position, returned by `getTerminalViewport`. */
export interface TerminalViewport {
  /** Buffer line shown at the top of the visible area. */
  viewportY: number;
  /** Buffer line shown at the top when scrolled fully to the bottom. */
  baseY: number;
}

/** The full set of commands the bridge understands. */
export type BridgeCommand =
  | ClickCommand
  | DoubleClickCommand
  | ResizeWindowCommand
  | TypeCommand
  | SelectCommand
  | ContextMenuCommand
  | PressKeyCommand
  | TerminalInputCommand
  | ExistsCommand
  | GetTextCommand
  | GetAttributeCommand
  | GetValueCommand
  | GetComputedStyleCommand
  | DragCommand
  | DragToCommand
  | ReadTerminalCommand
  | ScrollTerminalCommand
  | GetTerminalViewportCommand
  | GetStateCommand
  | ScreenshotCommand
  | EmitEventCommand
  | SeverAgentTransportCommand
  | ProjectionSubscribeCommand
  | ProjectionDispatchCommand
  | ProjectionStateCommand
  | ProjectionDropNextCommand
  | ProjectionResyncCommand
  | ProjectionUnsubscribeCommand;

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
