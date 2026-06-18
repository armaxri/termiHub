import type { BridgeCommand, BridgeResponse } from "./protocol";

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
  /** Set the value of the input/textarea carrying the given `data-testid`. */
  type(testId: string, text: string): Promise<void>;
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
  /** Open the right-click context menu of the element with the given `data-testid`. */
  contextMenu(testId: string): Promise<void>;
  /** Choose an `<option>` by value in the `<select>` with the given `data-testid`. */
  selectOption(testId: string, value: string): Promise<void>;
  /** Press a key on `testId` (or the focused element when omitted), e.g. `"Escape"`. */
  pressKey(key: string, testId?: string): Promise<void>;
  /** Read the reconstructed text of a terminal (active tab unless specified). */
  readTerminal(options?: ReadTerminalOptions): Promise<string>;
  /** Read a slice of app state, optionally by dot-path. */
  getState(path?: string): Promise<unknown>;
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

  async type(testId: string, text: string): Promise<void> {
    await this.send({ action: "type", testId, text });
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

  async contextMenu(testId: string): Promise<void> {
    await this.send({ action: "contextMenu", testId });
  }

  async selectOption(testId: string, value: string): Promise<void> {
    await this.send({ action: "selectOption", testId, value });
  }

  async pressKey(key: string, testId?: string): Promise<void> {
    await this.send({ action: "pressKey", key, testId });
  }

  async readTerminal(options: ReadTerminalOptions = {}): Promise<string> {
    return this.send<string>({
      action: "readTerminal",
      tabId: options.tabId,
      joinFullWidthRows: options.joinFullWidthRows,
    });
  }

  async getState(path?: string): Promise<unknown> {
    return this.send({ action: "getState", path });
  }
}
