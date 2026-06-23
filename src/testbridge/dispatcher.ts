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

/**
 * Yield to the event loop so React can flush a render + effects between
 * synthetic pointer events. @dnd-kit's `DndContext` measures droppable rects in
 * a post-activation render/effect cycle; without a yield, every pointer event
 * fires in one task and collision detection never sees those rects (so a drag
 * ends with `over: null` and reorders nothing). Two frames clears the commit and
 * its follow-up effects; falls back to `setTimeout` where rAF is unavailable.
 */
function nextFrame(): Promise<void> {
  const raf: (cb: FrameRequestCallback) => unknown =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb) => setTimeout(() => cb(0), 0);
  return new Promise((resolve) => raf(() => raf(() => resolve())));
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

    case "getValue": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("getValue", `no element with data-testid="${command.testId}"`);
      if (
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement) &&
        !(el instanceof HTMLSelectElement)
      ) {
        return fail(
          "getValue",
          `element data-testid="${command.testId}" has no value (not an input/textarea/select)`
        );
      }
      return ok("getValue", el.value);
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
      // Fire the realistic pointer→mouse sequence a real click produces, then the
      // native click(). A bare element.click() only fires a `click` event, which
      // libraries that open on pointerdown (Radix dropdown/menu triggers used
      // across the app) ignore — so menus never opened. Radix dedups the trailing
      // click on a pointerdown-opened trigger, so plain onClick handlers and menu
      // triggers both behave correctly.
      dispatchPointer(el, "pointerdown", x, y);
      dispatchMouse(el, "mousedown", x, y);
      dispatchPointer(el, "pointerup", x, y);
      dispatchMouse(el, "mouseup", x, y);
      (el as HTMLElement).click();
      return ok("click");
    }

    case "drag": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("drag", `no element with data-testid="${command.testId}"`);
      const { x: startX, y: startY } = centerOf(el);
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
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      // A nudge that comfortably clears the tab PointerSensor's activation
      // distance (`distance: 5` in SplitView.tsx) without reaching the target.
      const WAKE_DISTANCE = 12;
      // Intermediate moves toward the target; one frame is yielded after each so
      // dnd-kit re-measures and recomputes `over` as the pointer advances.
      const STEPS = 6;
      // Move toward (x, y) and yield a frame. @dnd-kit's PointerSensor only
      // *activates* once a move crosses its activation distance, and DndContext
      // then measures droppable rects in a React render/effect cycle from which
      // the drop target (`over`) is computed. Firing every event in one
      // synchronous task gives that cycle no chance to run, so collision
      // detection sees no rects, `over` stays null, and the drop reorders
      // nothing — hence the yield after every move. See docs/test-bridge.md.
      const moveTo = async (x: number, y: number): Promise<void> => {
        dispatchPointer(doc, "pointermove", x, y);
        await nextFrame();
      };

      // Press, wake the sensor past its activation distance, step to the target,
      // then release once the final position over the target has settled.
      dispatchPointer(from, "pointerdown", start.x, start.y);
      const dist = Math.hypot(dx, dy) || 1;
      await moveTo(start.x + (dx / dist) * WAKE_DISTANCE, start.y + (dy / dist) * WAKE_DISTANCE);
      for (let i = 1; i <= STEPS; i++) {
        await moveTo(start.x + (dx * i) / STEPS, start.y + (dy * i) / STEPS);
      }
      dispatchPointer(doc, "pointerup", end.x, end.y);
      return ok("dragTo");
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

    case "contextMenu": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("contextMenu", `no element with data-testid="${command.testId}"`);
      // Aim the event at the element's center so menu libraries that position at
      // the pointer (Radix `ContextMenu`) anchor sensibly. `getBoundingClientRect`
      // is absent in some jsdom paths, so fall back to the origin.
      const rect = (el as HTMLElement).getBoundingClientRect?.();
      const clientX = rect ? Math.round(rect.left + rect.width / 2) : 0;
      const clientY = rect ? Math.round(rect.top + rect.height / 2) : 0;
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX,
          clientY,
        })
      );
      return ok("contextMenu");
    }

    case "pressKey": {
      let target: EventTarget | null;
      if (command.testId) {
        target = findByTestId(deps.root, command.testId);
        if (!target) return fail("pressKey", `no element with data-testid="${command.testId}"`);
      } else {
        // No explicit target: aim at the focused element so a bare Escape/Enter
        // reaches document-level handlers (e.g. Radix's dismiss layer) by bubbling.
        const doc = deps.root instanceof Document ? deps.root : (deps.root.ownerDocument ?? null);
        target = doc?.activeElement ?? doc ?? null;
      }
      if (!target) return fail("pressKey", "no focused element to press a key on");
      const init: KeyboardEventInit = { key: command.key, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
      return ok("pressKey");
    }

    case "select": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("select", `no element with data-testid="${command.testId}"`);
      if (!(el instanceof HTMLSelectElement)) {
        return fail("select", `element data-testid="${command.testId}" is not a select`);
      }
      const options = Array.from(el.options).map((option) => option.value);
      if (!options.includes(command.value)) {
        return fail(
          "select",
          `option "${command.value}" not found in data-testid="${command.testId}" ` +
            `(have: ${options.join(", ")})`
        );
      }
      // Mirror the `type` workaround: drive the native value setter, then fire a
      // `change` event so React's controlled <select> onChange observes it.
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(el, command.value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return ok("select");
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
