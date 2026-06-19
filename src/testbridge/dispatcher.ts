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

/** The owning document of a bridge root (which may itself be a `Document`). */
function ownerDocument(root: ParentNode): Document {
  return root instanceof Document ? root : ((root as Element).ownerDocument ?? document);
}

/** Dispatch a bubbling, cancelable mouse event carrying viewport coordinates. */
function dispatchMouse(target: EventTarget, type: string, clientX: number, clientY: number): void {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY })
  );
}

/** The viewport-center of an element, used as the anchor for pointer gestures. */
function centerOf(el: Element): { x: number; y: number } {
  const rect = (el as HTMLElement).getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Dispatch a bubbling pointer event (falls back to MouseEvent where unavailable). */
function dispatchPointer(
  target: EventTarget,
  type: string,
  clientX: number,
  clientY: number
): void {
  const Ctor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  target.dispatchEvent(
    new Ctor(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
      clientY,
      ...(Ctor === PointerEvent ? { pointerId: 1, isPrimary: true } : {}),
    } as PointerEventInit)
  );
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

    case "getComputedStyle": {
      const doc = ownerDocument(deps.root);
      let el: Element | null;
      if (command.testId == null) {
        el = doc.documentElement;
      } else {
        el = findByTestId(deps.root, command.testId);
        if (!el) {
          return fail("getComputedStyle", `no element with data-testid="${command.testId}"`);
        }
      }
      const view = doc.defaultView ?? window;
      const value = view.getComputedStyle(el).getPropertyValue(command.property).trim();
      return ok("getComputedStyle", value);
    }

    case "click": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("click", `no element with data-testid="${command.testId}"`);
      const { x, y } = centerOf(el);
      // Fire the full pointer→mouse sequence a real click produces, so libraries
      // that open on pointerdown (Radix dropdown/menu triggers) respond. A Radix
      // *menu* trigger (aria-haspopup="menu") opens on pointerdown, so a trailing
      // click() would toggle it shut — skip it there; plain controls and
      // popover/dialog triggers (which open on click) still get the click().
      dispatchPointer(el, "pointerdown", x, y);
      dispatchMouse(el, "mousedown", x, y);
      dispatchPointer(el, "pointerup", x, y);
      dispatchMouse(el, "mouseup", x, y);
      if (el.getAttribute("aria-haspopup") !== "menu") {
        (el as HTMLElement).click();
      }
      return ok("click");
    }

    case "drag": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("drag", `no element with data-testid="${command.testId}"`);
      const rect = (el as HTMLElement).getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      const endX = startX + command.dx;
      const endY = startY + (command.dy ?? 0);
      // Press on the handle, then move/release on the document — drag handlers
      // (e.g. useSidebarResize) attach mousemove/mouseup there and read clientX.
      const doc = ownerDocument(deps.root);
      dispatchMouse(el, "mousedown", startX, startY);
      dispatchMouse(doc, "mousemove", endX, endY);
      dispatchMouse(doc, "mouseup", endX, endY);
      return ok("drag");
    }

    case "dragTo": {
      const from = findByTestId(deps.root, command.fromTestId);
      if (!from) return fail("dragTo", `no element with data-testid="${command.fromTestId}"`);
      const to = findByTestId(deps.root, command.toTestId);
      if (!to) return fail("dragTo", `no element with data-testid="${command.toTestId}"`);
      const start = centerOf(from);
      const end = centerOf(to);
      const doc = ownerDocument(deps.root);
      // Press on the source, nudge past the sensor's activation distance, then
      // step to the target center before releasing — what @dnd-kit listens for.
      dispatchPointer(from, "pointerdown", start.x, start.y);
      const steps = 4;
      for (let i = 1; i <= steps; i++) {
        const x = start.x + ((end.x - start.x) * i) / steps;
        const y = start.y + ((end.y - start.y) * i) / steps;
        dispatchPointer(doc, "pointermove", x, y);
      }
      dispatchPointer(doc, "pointerup", end.x, end.y);
      return ok("dragTo");
    }

    case "rightClick": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("rightClick", `no element with data-testid="${command.testId}"`);
      const { x, y } = centerOf(el);
      // Radix's ContextMenu.Trigger opens on the native `contextmenu` event; the
      // pointer/mouse pair mirrors a real secondary-button press around it.
      el.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 2 })
      );
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }));
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: x,
          clientY: y,
        })
      );
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 2 }));
      return ok("rightClick");
    }

    case "key": {
      const doc = ownerDocument(deps.root);
      const target: EventTarget = doc.activeElement ?? doc.body ?? doc;
      const init: KeyboardEventInit = {
        key: command.key,
        bubbles: true,
        cancelable: true,
        ctrlKey: command.ctrl ?? false,
        metaKey: command.meta ?? false,
        shiftKey: command.shift ?? false,
        altKey: command.alt ?? false,
      };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
      return ok("key");
    }

    case "selectOption": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("selectOption", `no element with data-testid="${command.testId}"`);
      if (!(el instanceof HTMLSelectElement)) {
        return fail("selectOption", `element data-testid="${command.testId}" is not a <select>`);
      }
      const hasOption = Array.from(el.options).some((opt) => opt.value === command.value);
      if (!hasOption) {
        return fail(
          "selectOption",
          `<select> "${command.testId}" has no option value "${command.value}"`
        );
      }
      // Drive React's controlled <select> via the native value setter, then fire
      // change — the same pattern `type` uses for inputs.
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(el, command.value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return ok("selectOption");
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
