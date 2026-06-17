import type { BridgeCommand, BridgeResponse } from "./protocol";

/**
 * Dependencies the {@link dispatchCommand} function resolves commands against.
 *
 * Injecting these (rather than reaching for globals) keeps the dispatcher a pure,
 * unit-testable function: tests supply a DOM fragment and stub readers, while the
 * live {@link TestBridge} component wires in the real {@link TerminalRegistry} and
 * Zustand store.
 */
export interface BridgeDeps {
  /** Root node that `data-testid` selectors are resolved against. */
  root: ParentNode;
  /**
   * Read a terminal's reconstructed logical-line text, or `undefined` when no
   * terminal is registered for `tabId`.
   */
  readTerminal: (tabId: string, joinFullWidthRows: boolean) => string | undefined;
  /** The currently active terminal tab id, or `undefined` when none is focused. */
  getActiveTabId: () => string | undefined;
  /** A snapshot of the app store state for introspection. */
  getState: () => Record<string, unknown>;
  /**
   * Write `text` into the backend session bound to `tabId`, resolving to `true`
   * when a session was found and the input was sent, or `false` when no session
   * is registered for the tab. Routes through the session's `send_input` choke
   * point so line-ending normalization applies, exactly like interactive typing.
   */
  sendTerminalInput: (tabId: string, text: string) => Promise<boolean>;
}

/** Resolve an element by its `data-testid`, escaping the value for the selector. */
function findByTestId(root: ParentNode, testId: string): Element | null {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(testId)
      : testId.replace(/["\\]/g, "\\$&");
  return root.querySelector(`[data-testid="${escaped}"]`);
}

/** Walk a dot-path into a plain object, returning a sentinel when unresolvable. */
const MISSING = Symbol("missing");
function resolvePath(state: Record<string, unknown>, path: string): unknown {
  let current: unknown = state;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return MISSING;
    if (!(key in (current as Record<string, unknown>))) return MISSING;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const ok = (action: BridgeCommand["action"], value?: unknown): BridgeResponse =>
  value === undefined ? { ok: true, action } : { ok: true, action, value };

const fail = (action: BridgeCommand["action"], error: string): BridgeResponse => ({
  ok: false,
  action,
  error,
});

/**
 * Execute a single {@link BridgeCommand} against the live app and return a
 * structured {@link BridgeResponse}.
 *
 * The function never throws: every failure path produces an `ok: false` response
 * with an agent-readable `error`, so a test runner can branch on the result
 * rather than catch exceptions. It is async because `terminalInput` awaits the
 * session send path; the other commands resolve immediately.
 */
export async function dispatchCommand(
  command: BridgeCommand,
  deps: BridgeDeps
): Promise<BridgeResponse> {
  switch (command.action) {
    case "exists": {
      return ok("exists", findByTestId(deps.root, command.testId) !== null);
    }

    case "getText": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("getText", `no element with data-testid="${command.testId}"`);
      return ok("getText", el.textContent ?? "");
    }

    case "getAttribute": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("getAttribute", `no element with data-testid="${command.testId}"`);
      return ok("getAttribute", el.getAttribute(command.attribute));
    }

    case "click": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("click", `no element with data-testid="${command.testId}"`);
      (el as HTMLElement).click();
      return ok("click");
    }

    case "type": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("type", `no element with data-testid="${command.testId}"`);
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
        return fail("type", `element data-testid="${command.testId}" is not an input or textarea`);
      }
      // Drive React's controlled inputs via the native value setter, then fire an
      // input event — the same approach the E2E helpers use to remain robust
      // against WebKitGTK keyboard-state corruption after terminal sessions.
      const prototype =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(el, command.text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return ok("type");
    }

    case "terminalInput": {
      const tabId = command.tabId ?? deps.getActiveTabId();
      if (!tabId) return fail("terminalInput", "no active terminal to write to");
      // Append a newline so the command runs, matching interactive Enter — the
      // backend's send_input choke point normalizes it to the session's
      // configured line ending (same path as `initialCommand + "\n"`).
      const sent = await deps.sendTerminalInput(tabId, command.text + "\n");
      return sent
        ? ok("terminalInput")
        : fail("terminalInput", `no terminal session registered for tab "${tabId}"`);
    }

    case "readTerminal": {
      const tabId = command.tabId ?? deps.getActiveTabId();
      if (!tabId) return fail("readTerminal", "no active terminal to read");
      const content = deps.readTerminal(tabId, command.joinFullWidthRows ?? false);
      if (content === undefined) {
        return fail("readTerminal", `no terminal registered for tab "${tabId}"`);
      }
      return ok("readTerminal", content);
    }

    case "getState": {
      const state = deps.getState();
      // `== null` catches both an omitted path and an explicit JSON `null` — a
      // remote client (e.g. the Python harness) sends `null`, not `undefined`.
      if (command.path == null) return ok("getState", state);
      const resolved = resolvePath(state, command.path);
      if (resolved === MISSING) {
        return fail("getState", `state path "${command.path}" does not resolve`);
      }
      return ok("getState", resolved);
    }

    default: {
      const action = (command as { action?: unknown }).action;
      return {
        ok: false,
        action: String(action) as BridgeCommand["action"],
        error: `unknown command action "${String(action)}"`,
      };
    }
  }
}
