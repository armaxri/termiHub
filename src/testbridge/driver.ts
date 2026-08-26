import type { BridgeCommand, BridgeResponse, TerminalViewport } from "./protocol";

/**
 * Transport that carries a {@link BridgeCommand} to the running app and returns
 * its {@link BridgeResponse}.
 *
 * This is the seam that makes the harness platform-agnostic. Different transports
 * reach the same in-app bridge by different routes:
 *  - {@link inProcessTransport} — calls `window.__termihubTestBridge` directly
 *    (in-process, or via WebDriver `browser.execute`).
 *  - a future WebSocket transport — talks to a backend-hosted control channel,
 *    which is how macOS is driven where no WKWebView WebDriver exists (ADR-5).
 *
 * The {@link Driver} above never knows which transport is underneath.
 */
export type BridgeTransport = (command: BridgeCommand) => BridgeResponse | Promise<BridgeResponse>;

/** Raised when a bridge command returns an `ok: false` response. */
export class BridgeError extends Error {
  constructor(
    public readonly action: BridgeCommand["action"],
    message: string
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Options for {@link Driver.terminalInput}. */
export interface TerminalInputOptions {
  /** Write into this specific tab's terminal instead of the active one. */
  tabId?: string;
}

/** Options for {@link Driver.readTerminal}. */
export interface ReadTerminalOptions {
  /** Read this specific tab instead of the active one. */
  tabId?: string;
  /** Rejoin hard wraps at the terminal width (matches "Save to File"). */
  joinFullWidthRows?: boolean;
}

/** Modifier keys held during a {@link Driver.pressKey} chord. */
export interface KeyModifiers {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Options for {@link Driver.getComputedStyle}. */
export interface GetComputedStyleOptions {
  /** Read this element instead of the document root (theme CSS variables). */
  testId?: string;
}

/** Options for {@link Driver.scrollTerminal}. */
export interface ScrollTerminalOptions {
  /** Scroll this specific tab instead of the active one. */
  tabId?: string;
  /** Signed line delta (negative = up into scrollback); ignored when `toBottom`. */
  lines?: number;
  /** Jump straight to the bottom (resumes auto-scroll), ignoring `lines`. */
  toBottom?: boolean;
}

/** Options for {@link Driver.getTerminalViewport}. */
export interface GetTerminalViewportOptions {
  /** Read this specific tab instead of the active one. */
  tabId?: string;
}

/**
 * The abstraction test authors and coding agents program against.
 *
 * It exposes the same verbs regardless of platform or transport: press buttons,
 * type into fields, read the terminal, and inspect app state. Query methods
 * resolve to their value; action methods resolve when applied. Any underlying
 * failure rejects with a {@link BridgeError} carrying an agent-readable message,
 * so a scenario runner can turn it into structured feedback.
 */
export interface Driver {
  /** Press the control carrying the given `data-testid`. */
  click(testId: string): Promise<void>;
  /**
   * Double-click the element with the given `data-testid` — the "activate"
   * gesture for opening a connection, entering a directory, or opening a file.
   */
  doubleClick(testId: string): Promise<void>;
  /** Resize the application window to `width` × `height` logical pixels (Tauri). */
  resizeWindow(width: number, height: number): Promise<void>;
  /** Set the value of the input/textarea carrying the given `data-testid`. */
  type(testId: string, text: string): Promise<void>;
  /** Choose `value` on the native `<select>` carrying the given `data-testid`. */
  select(testId: string, value: string): Promise<void>;
  /** Open the right-click context menu of the element with the given `data-testid`. */
  contextMenu(testId: string): Promise<void>;
  /**
   * Press a key on `testId` (or the focused element when omitted), e.g.
   * `"Escape"`. Pass `modifiers` for chords like `Ctrl+S` / `Ctrl+End` — the
   * dispatched event carries a real legacy `keyCode`, so keybinding-driven
   * editors (Monaco) respond as they do to real input.
   */
  pressKey(key: string, testId?: string, modifiers?: KeyModifiers): Promise<void>;
  /** Drag one element onto another (pointer-based, e.g. @dnd-kit reordering). */
  dragTo(fromTestId: string, toTestId: string): Promise<void>;
  /**
   * Send input into a terminal session (active tab unless `tabId` is given). A
   * trailing newline is appended, so `terminalInput("ls")` runs `ls`.
   */
  terminalInput(text: string, options?: TerminalInputOptions): Promise<void>;
  /** Whether an element with the given `data-testid` is currently present. */
  exists(testId: string): Promise<boolean>;
  /** Read the visible text of the element with the given `data-testid`. */
  getText(testId: string): Promise<string>;
  /** Read an attribute of the element with the given `data-testid`. */
  getAttribute(testId: string, attribute: string): Promise<string | null>;
  /**
   * Read the live `value` of an `<input>`/`<textarea>`/`<select>` — the DOM
   * property a controlled field updates, which {@link getAttribute} cannot see.
   */
  getValue(testId: string): Promise<string>;
  /**
   * Read a computed CSS property (including custom properties). Pass `testId` to
   * read an element; omit it to read the document root, where theme CSS variables
   * like `--bg-primary` live.
   */
  getComputedStyle(property: string, options?: GetComputedStyleOptions): Promise<string>;
  /** Drag an element by a pixel delta (e.g. a resize handle). */
  drag(testId: string, dx: number, dy?: number): Promise<void>;
  /** Read the reconstructed text of a terminal (active tab unless specified). */
  readTerminal(options?: ReadTerminalOptions): Promise<string>;
  /**
   * Scroll a terminal's viewport by `options.lines` logical lines (negative = up
   * into scrollback) or to the bottom when `options.toBottom` is set. Fires the
   * same `onScroll` event a wheel gesture would, so the auto-scroll guard (#504)
   * observes it. Active tab unless `options.tabId` is given.
   */
  scrollTerminal(options?: ScrollTerminalOptions): Promise<void>;
  /**
   * Read a terminal's `{ viewportY, baseY }` scroll position. `viewportY < baseY`
   * means scrolled up into scrollback; equal means pinned to the bottom. Active
   * tab unless `options.tabId` is given.
   */
  getTerminalViewport(options?: GetTerminalViewportOptions): Promise<TerminalViewport>;
  /** Read a slice of app state, optionally by dot-path. */
  getState(path?: string): Promise<unknown>;
  /**
   * Capture a PNG screenshot of the rendered app as a `data:image/png;base64,…`
   * URL — visual evidence for a manual carve-out or a failure bundle. Rasterizes
   * the DOM, so it does not capture the xterm GPU canvas or native OS dialogs.
   */
  screenshot(): Promise<string>;
  /**
   * Emit a Tauri `event` with `payload` into the app (test mode only).
   *
   * The only way to drive UI that renders solely from a backend-originated
   * event, e.g. surfacing the deferred-update banner with an
   * `agent-update-available` event. The app's real listeners and store-folding
   * hooks run, so the event path itself stays covered.
   */
  emitEvent(event: string, payload?: unknown): Promise<void>;
  /**
   * Abruptly sever a connected agent's transport in-process (test mode only,
   * #2573) to drive the agent-reconnect UI grade (#2574). Unlike a clean
   * disconnect the agent's I/O task stays alive and reconnects. Resolves to
   * `true` when a live agent received the sever, `false` for an unknown/dead one.
   */
  severAgentTransport(agentId: string): Promise<boolean>;
}

/**
 * Default transport that calls the in-app bridge installed on `window`.
 *
 * Works in-process and inside WebDriver's `browser.execute`. Throws if the bridge
 * is absent, which usually means test mode was not enabled before the app booted.
 */
export const inProcessTransport: BridgeTransport = (command) => {
  const bridge = window.__termihubTestBridge;
  if (!bridge) {
    throw new BridgeError(
      command.action,
      "test bridge is not installed — enable test mode before launching the app"
    );
  }
  return bridge.dispatch(command);
};

/**
 * A {@link Driver} backed by a {@link BridgeTransport}.
 *
 * Defaults to the {@link inProcessTransport}, so `new InAppBridgeDriver()` drives
 * the app running in the same realm; pass a transport to target a remote app.
 */
export class InAppBridgeDriver implements Driver {
  constructor(private readonly transport: BridgeTransport = inProcessTransport) {}

  /** Send a command and unwrap its value, rejecting on an `ok: false` response. */
  private async send<T = unknown>(command: BridgeCommand): Promise<T> {
    const res = await this.transport(command);
    if (!res.ok) {
      throw new BridgeError(res.action, res.error ?? `command "${res.action}" failed`);
    }
    return res.value as T;
  }

  async click(testId: string): Promise<void> {
    await this.send({ action: "click", testId });
  }

  async doubleClick(testId: string): Promise<void> {
    await this.send({ action: "doubleClick", testId });
  }

  async resizeWindow(width: number, height: number): Promise<void> {
    await this.send({ action: "resizeWindow", width, height });
  }

  async type(testId: string, text: string): Promise<void> {
    await this.send({ action: "type", testId, text });
  }

  async select(testId: string, value: string): Promise<void> {
    await this.send({ action: "select", testId, value });
  }

  async contextMenu(testId: string): Promise<void> {
    await this.send({ action: "contextMenu", testId });
  }

  async pressKey(key: string, testId?: string, modifiers: KeyModifiers = {}): Promise<void> {
    await this.send({
      action: "pressKey",
      key,
      testId,
      ctrl: modifiers.ctrl,
      meta: modifiers.meta,
      shift: modifiers.shift,
      alt: modifiers.alt,
    });
  }

  async dragTo(fromTestId: string, toTestId: string): Promise<void> {
    await this.send({ action: "dragTo", fromTestId, toTestId });
  }

  async terminalInput(text: string, options: TerminalInputOptions = {}): Promise<void> {
    await this.send({ action: "terminalInput", text, tabId: options.tabId });
  }

  async exists(testId: string): Promise<boolean> {
    return this.send<boolean>({ action: "exists", testId });
  }

  async getText(testId: string): Promise<string> {
    return this.send<string>({ action: "getText", testId });
  }

  async getAttribute(testId: string, attribute: string): Promise<string | null> {
    return this.send<string | null>({ action: "getAttribute", testId, attribute });
  }

  async getValue(testId: string): Promise<string> {
    return this.send<string>({ action: "getValue", testId });
  }

  async getComputedStyle(property: string, options: GetComputedStyleOptions = {}): Promise<string> {
    return this.send<string>({ action: "getComputedStyle", testId: options.testId, property });
  }

  async drag(testId: string, dx: number, dy?: number): Promise<void> {
    await this.send({ action: "drag", testId, dx, dy });
  }

  async readTerminal(options: ReadTerminalOptions = {}): Promise<string> {
    return this.send<string>({
      action: "readTerminal",
      tabId: options.tabId,
      joinFullWidthRows: options.joinFullWidthRows,
    });
  }

  async scrollTerminal(options: ScrollTerminalOptions = {}): Promise<void> {
    await this.send({
      action: "scrollTerminal",
      tabId: options.tabId,
      lines: options.lines,
      toBottom: options.toBottom,
    });
  }

  async getTerminalViewport(options: GetTerminalViewportOptions = {}): Promise<TerminalViewport> {
    return this.send<TerminalViewport>({
      action: "getTerminalViewport",
      tabId: options.tabId,
    });
  }

  async getState(path?: string): Promise<unknown> {
    return this.send({ action: "getState", path });
  }

  async screenshot(): Promise<string> {
    return this.send<string>({ action: "screenshot" });
  }

  async emitEvent(event: string, payload?: unknown): Promise<void> {
    await this.send({ action: "emitEvent", event, payload });
  }

  async severAgentTransport(agentId: string): Promise<boolean> {
    return await this.send<boolean>({ action: "severAgentTransport", agentId });
  }
}
