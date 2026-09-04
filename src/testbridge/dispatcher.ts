import type { IntentAck } from "@/services/transport";

import type { ProjectionDispatchRequest, ProjectionRecordingState } from "./projectionRecorder";
import type { BridgeCommand, BridgeResponse } from "./protocol";

/**
 * The subset of {@link import("./projectionRecorder").ProjectionRecorder} the
 * dispatcher drives. Injected (not imported concretely) so unit tests supply a
 * fake transport-backed recorder and the live {@link import("./TestBridge").TestBridge}
 * wires the real one — mirroring how `resizeWindow`/`screenshot` are injected.
 */
export interface ProjectionApi {
  subscribe(region: string): Promise<ProjectionRecordingState>;
  dispatch(request: ProjectionDispatchRequest): Promise<IntentAck>;
  state(subscriptionId: string): ProjectionRecordingState;
  dropNext(subscriptionId: string, count: number): void;
  resync(subscriptionId: string): Promise<ProjectionRecordingState>;
  unsubscribe(subscriptionId: string): void;
}

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
  /**
   * Scroll a terminal's viewport by `lines` (negative = up) or to the bottom,
   * resolving to `true` when a terminal exists for `tabId`, `false` otherwise.
   */
  scrollTerminal: (tabId: string, lines: number, toBottom: boolean) => boolean;
  /**
   * Read a terminal's `{ viewportY, baseY }` scroll position, or `undefined`
   * when no terminal is registered for `tabId`.
   */
  getTerminalViewport: (tabId: string) => { viewportY: number; baseY: number } | undefined;
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
  /**
   * Resize the application window to `width` × `height` logical pixels, rejecting
   * if the platform window is unavailable. The live {@link TestBridge} wires this
   * to Tauri's `getCurrentWindow().setSize(...)`; unit tests supply a stub.
   */
  resizeWindow: (width: number, height: number) => Promise<void>;
  /**
   * Capture a PNG screenshot of the rendered app as a `data:image/png;base64,…`
   * URL, rejecting if capture is unavailable. The live {@link TestBridge} wires
   * this to a DOM rasterizer; unit tests supply a stub.
   */
  screenshot: () => Promise<string>;
  /**
   * Emit a Tauri event with `payload` into the running app, rejecting if the
   * event bus is unavailable or test mode is off. The live {@link TestBridge}
   * wires this to Tauri's `emit(...)` behind a test-mode re-check; unit tests
   * supply a stub. This is the bridge's only non-DOM injection path — see
   * {@link EmitEventCommand} for why it exists.
   */
  emitEvent: (event: string, payload: unknown) => Promise<void>;
  /**
   * Abruptly sever a connected agent's transport in-process (#2573) to drive the
   * automated agent-reconnect UI grade (#2574), resolving to `true` when a live
   * agent received the sever and `false` for an unknown/dead one. The live
   * {@link import("./TestBridge").TestBridge} wires this to the test-bridge-gated
   * `test_sever_agent_transport` Tauri command behind a test-mode re-check; unit
   * tests supply a stub. Optional — absent outside the harness, so the
   * `severAgentTransport` verb then fails with a clear "not available" error.
   */
  severAgentTransport?: (agentId: string) => Promise<boolean>;
  /**
   * Drive the projection substrate (#2149) for the assertion harness (#2164):
   * subscribe to a region and record its pushed frames, dispatch intents, force
   * a gap, resync. The live {@link import("./TestBridge").TestBridge} wires a
   * {@link import("./projectionRecorder").ProjectionRecorder} over the real
   * transport; unit tests supply a fake. Optional — absent outside the harness,
   * so the `projection*` verbs then fail with a clear "not available" error
   * rather than throw.
   */
  projection?: ProjectionApi;
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
 * Fire the realistic pointer→mouse→click sequence a real click produces.
 *
 * A bare `element.click()` only fires a `click` event, which libraries that open
 * on pointerdown (Radix dropdown/menu triggers used across the app) ignore — so
 * menus never open. Radix dedups the trailing click on a pointerdown-opened
 * trigger, so plain onClick handlers and menu triggers both behave correctly.
 * Shared by the `click` and `doubleClick` verbs.
 */
function clickSequence(el: Element, x: number, y: number): void {
  dispatchPointer(el, "pointerdown", x, y);
  dispatchMouse(el, "mousedown", x, y);
  dispatchPointer(el, "pointerup", x, y);
  dispatchMouse(el, "mouseup", x, y);
  (el as HTMLElement).click();
}

/**
 * Drive the design-system {@link Select} (a Radix `Select` skin) from the bridge.
 *
 * The visible testid sits on the button trigger, so a native `.value` set is not
 * available. Instead reproduce a real interaction: open the listbox via the
 * realistic pointer sequence, then click the option whose `data-value` matches.
 * Radix portals its content, so options are searched in both the bridge root and
 * the owning document (where the portal lands under `<body>`).
 */
async function selectRadixOption(
  root: ParentNode,
  trigger: Element,
  value: string
): Promise<string | null> {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(value)
      : value.replace(/["\\]/g, "\\$&");
  // Scope to `.ui-select__item` so the trigger's own `data-value` mirror never
  // matches — only the mounted listbox options do.
  const optionSelector = `.ui-select__item[data-value="${escaped}"]`;

  const findOption = (): Element | null =>
    root.querySelector(optionSelector) ?? ownerDocument(root).querySelector(optionSelector);

  // Open the listbox. Radix Select opens reliably on keyboard activation across
  // both a real WebView and jsdom (its pointerdown-to-open path depends on
  // pointer-capture APIs that behave inconsistently), so focus + Enter.
  (trigger as HTMLElement).focus();
  trigger.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
  );

  // Radix portals the listbox content asynchronously (open-state re-render +
  // portal mount + position effect), so the option is usually not in the DOM on
  // the same tick. Poll across a bounded number of frames before giving up — the
  // live Python bridge issues a single `select` with no retry, so waiting here is
  // what makes one call sufficient (SELECT_MOUNT_FRAMES × ~2 rAF ≈ up to ~1s).
  let option = findOption();
  for (let i = 0; i < SELECT_MOUNT_FRAMES && !option; i++) {
    await nextFrame();
    option = findOption();
  }
  if (!option) {
    return `option "${value}" not found in the open Radix listbox`;
  }
  const optAnchor = centerOf(option);
  clickSequence(option, optAnchor.x, optAnchor.y);
  return null;
}

/** Frames to wait for a Radix listbox option to portal-mount before failing. */
const SELECT_MOUNT_FRAMES = 30;

/** Named DOM keys whose `code` / legacy `keyCode` aren't derivable from the char. */
const NAMED_KEYS: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  " ": { code: "Space", keyCode: 32 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};

/** The `KeyboardEvent.code` for a DOM key value (e.g. `"s"` → `"KeyS"`). */
function domCodeFor(key: string): string | undefined {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key].code;
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return undefined;
}

/** The legacy numeric `keyCode` for a DOM key value, or 0 when unknown. */
function legacyKeyCodeFor(key: string): number {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key].keyCode;
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return 0;
}

/**
 * Build a `KeyboardEvent` with a working legacy `keyCode`.
 *
 * The `keyCode` property is read-only and absent from `KeyboardEventInit`, but
 * Monaco's `StandardKeyboardEvent` still reads `e.keyCode` (the deprecated
 * numeric) to resolve keybindings — a synthetic event leaves it `0`, so
 * `Ctrl+S` / `Ctrl+End` would resolve to `Unknown` and do nothing. Defining the
 * property after construction is the portable way to give the event a real
 * `keyCode` so keybinding-driven editors respond as they do to real input.
 */
function keyboardEvent(type: string, init: KeyboardEventInit, key: string): KeyboardEvent {
  const event = new KeyboardEvent(type, init);
  const keyCode = legacyKeyCodeFor(key);
  if (keyCode) {
    Object.defineProperty(event, "keyCode", { get: () => keyCode });
    Object.defineProperty(event, "which", { get: () => keyCode });
  }
  return event;
}

/**
 * Upper bound (ms) on how long {@link nextFrame} waits for its two rAF ticks
 * before a wall-clock timer resolves it instead. See {@link nextFrame}.
 */
const FRAME_YIELD_FALLBACK_MS = 100;

/**
 * Yield to the event loop so React can flush a render + effects between
 * synthetic pointer events. @dnd-kit's `DndContext` measures droppable rects in
 * a post-activation render/effect cycle; without a yield, every pointer event
 * fires in one task and collision detection never sees those rects (so a drag
 * ends with `over: null` and reorders nothing). Two frames clears the commit and
 * its follow-up effects.
 *
 * Never resolves purely on `requestAnimationFrame`: a real WebView *has* rAF but
 * **throttles or fully pauses it when its window is occluded or backgrounded**
 * (a macOS WKWebView compositor behavior, aggravated by concurrent build load).
 * A frame-poll that awaits rAF alone then stalls with no frames delivered, so
 * the `select`/`dragTo` verbs that call this hang until the bridge's 10s command
 * timeout fires — the #2460 symptom. So race the two rAF ticks against a
 * wall-clock fallback: under a healthy rAF the double-tick (~32 ms) wins and
 * dnd-kit still gets its two real frames; under a throttled/paused rAF the timer
 * wins and the caller advances instead of hanging. Also covers environments with
 * no rAF at all (falls back to the timer alone).
 */
function nextFrame(): Promise<void> {
  const viaTimer = new Promise<void>((resolve) => setTimeout(resolve, FRAME_YIELD_FALLBACK_MS));
  if (typeof requestAnimationFrame !== "function") return viaTimer;
  const viaFrames = new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  return Promise.race([viaFrames, viaTimer]);
}

/**
 * @dnd-kit's `PointerSensor.detach()` removes its document-level listeners on a
 * `setTimeout(removeAll, 50)` (see `AbstractPointerSensor.detach` in
 * `@dnd-kit/core`). One of those is a **capture-phase `click` listener installed
 * on drag activation that `stopPropagation`s every click** — so a `click` verb
 * fired within ~50 ms of a drag's `pointerup` is swallowed and its handler never
 * runs (the drop's own effect has landed, but the *following* click is eaten).
 * `dragTo` therefore waits past that teardown window before resolving, so any
 * verb issued after a drag (e.g. clicking the tab-group chip a just-moved tab was
 * dropped onto, #2609) sees a settled DOM. 80 ms clears the 50 ms timer plus
 * scheduling jitter.
 */
const DRAG_END_SETTLE_MS = 80;
function settleAfterDrag(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, DRAG_END_SETTLE_MS));
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

/** Error returned by every `projection*` verb when the recorder is not wired. */
const PROJECTION_UNAVAILABLE =
  "projection recorder is not available (test bridge not in projection mode)";

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
      // Radix `Select` primitive: the value lives in the trigger's `data-value`
      // (there is no native `.value`), mirrored by the `Select` component.
      if (el.classList.contains("ui-select__trigger")) {
        return ok("getValue", el.getAttribute("data-value") ?? "");
      }
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
      clickSequence(el, x, y);
      return ok("click");
    }

    case "doubleClick": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("doubleClick", `no element with data-testid="${command.testId}"`);
      const { x, y } = centerOf(el);
      // A real double-click fires two full click rounds, then a `dblclick` — the
      // event React's `onDoubleClick` listens for (e.g. sidebar connect, which is
      // the only path that raises the SSH key-passphrase prompt).
      clickSequence(el, x, y);
      clickSequence(el, x, y);
      dispatchMouse(el, "dblclick", x, y);
      return ok("doubleClick");
    }

    case "resizeWindow": {
      try {
        await deps.resizeWindow(command.width, command.height);
        return ok("resizeWindow");
      } catch (error) {
        return fail("resizeWindow", error instanceof Error ? error.message : String(error));
      }
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
      const start = centerOf(from);
      const doc = ownerDocument(deps.root);
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

      // Some drop targets — the `PanelDropZone` edge/center overlays (#2583) —
      // mount only *while a drag is active*, so they cannot be resolved before
      // `pointerdown`. Resolve the target up-front when it already exists (tab
      // reorder, sidebar drops); otherwise press first, wake the sensor so the
      // drag-only zones mount, then resolve the now-present target.
      let to = findByTestId(deps.root, command.toTestId);
      dispatchPointer(from, "pointerdown", start.x, start.y);

      if (!to) {
        // Nudge past the activation distance in a fixed direction — the only
        // requirement is to cross it so the drop zones render; the real target
        // coordinates are read afterwards.
        await moveTo(start.x + WAKE_DISTANCE, start.y);
        to = findByTestId(deps.root, command.toTestId);
        if (!to) {
          // Release so no drag is left dangling, then report the miss.
          dispatchPointer(doc, "pointerup", start.x + WAKE_DISTANCE, start.y);
          return fail("dragTo", `no element with data-testid="${command.toTestId}"`);
        }
        const end = centerOf(to);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        for (let i = 1; i <= STEPS; i++) {
          await moveTo(start.x + (dx * i) / STEPS, start.y + (dy * i) / STEPS);
        }
        dispatchPointer(doc, "pointerup", end.x, end.y);
        await settleAfterDrag();
        return ok("dragTo");
      }

      // Target already present: wake toward it, step to it, then release once the
      // final position over the target has settled.
      const end = centerOf(to);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const dist = Math.hypot(dx, dy) || 1;
      await moveTo(start.x + (dx / dist) * WAKE_DISTANCE, start.y + (dy / dist) * WAKE_DISTANCE);
      for (let i = 1; i <= STEPS; i++) {
        await moveTo(start.x + (dx * i) / STEPS, start.y + (dy * i) / STEPS);
      }
      dispatchPointer(doc, "pointerup", end.x, end.y);
      await settleAfterDrag();
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
      const init: KeyboardEventInit = {
        key: command.key,
        code: domCodeFor(command.key),
        ctrlKey: command.ctrl ?? false,
        metaKey: command.meta ?? false,
        shiftKey: command.shift ?? false,
        altKey: command.alt ?? false,
        bubbles: true,
        cancelable: true,
      };
      target.dispatchEvent(keyboardEvent("keydown", init, command.key));
      target.dispatchEvent(keyboardEvent("keyup", init, command.key));
      return ok("pressKey");
    }

    case "select": {
      const el = findByTestId(deps.root, command.testId);
      if (!el) return fail("select", `no element with data-testid="${command.testId}"`);

      // Radix `Select` primitive (the `ui/` design-system control): its testid
      // lands on the button trigger, not a native <select>. Drive it like a real
      // user — open the listbox, then click the option whose `data-value` matches.
      if (el.classList.contains("ui-select__trigger")) {
        const err = await selectRadixOption(deps.root, el, command.value);
        return err ? fail("select", err) : ok("select");
      }

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

    case "scrollTerminal": {
      const tabId = command.tabId ?? deps.getActiveTabId();
      if (!tabId) return fail("scrollTerminal", "no active terminal to scroll");
      const scrolled = deps.scrollTerminal(tabId, command.lines ?? 0, command.toBottom ?? false);
      return scrolled
        ? ok("scrollTerminal")
        : fail("scrollTerminal", `no terminal registered for tab "${tabId}"`);
    }

    case "getTerminalViewport": {
      const tabId = command.tabId ?? deps.getActiveTabId();
      if (!tabId) return fail("getTerminalViewport", "no active terminal to read");
      const viewport = deps.getTerminalViewport(tabId);
      if (viewport === undefined) {
        return fail("getTerminalViewport", `no terminal registered for tab "${tabId}"`);
      }
      return ok("getTerminalViewport", viewport);
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

    case "screenshot": {
      try {
        return ok("screenshot", await deps.screenshot());
      } catch (error) {
        return fail("screenshot", error instanceof Error ? error.message : String(error));
      }
    }

    case "emitEvent": {
      // Reject an empty name here rather than at the bus: Tauri would fail with
      // an opaque plugin error, and a test author's typo deserves a direct one.
      if (!command.event) return fail("emitEvent", "event name is required");
      try {
        await deps.emitEvent(command.event, command.payload);
        return ok("emitEvent");
      } catch (error) {
        return fail("emitEvent", error instanceof Error ? error.message : String(error));
      }
    }

    case "severAgentTransport": {
      if (!command.agentId) return fail("severAgentTransport", "agentId is required");
      if (!deps.severAgentTransport) {
        return fail("severAgentTransport", "agent transport sever is not available");
      }
      try {
        return ok("severAgentTransport", await deps.severAgentTransport(command.agentId));
      } catch (error) {
        return fail("severAgentTransport", error instanceof Error ? error.message : String(error));
      }
    }

    case "projectionSubscribe": {
      if (!deps.projection) return fail("projectionSubscribe", PROJECTION_UNAVAILABLE);
      try {
        return ok("projectionSubscribe", await deps.projection.subscribe(command.region));
      } catch (error) {
        return fail("projectionSubscribe", error instanceof Error ? error.message : String(error));
      }
    }

    case "projectionDispatch": {
      if (!deps.projection) return fail("projectionDispatch", PROJECTION_UNAVAILABLE);
      try {
        const ack = await deps.projection.dispatch({
          kind: command.kind,
          payload: command.payload,
          intentId: command.intentId,
          clientId: command.clientId,
        });
        return ok("projectionDispatch", ack);
      } catch (error) {
        return fail("projectionDispatch", error instanceof Error ? error.message : String(error));
      }
    }

    case "projectionState": {
      if (!deps.projection) return fail("projectionState", PROJECTION_UNAVAILABLE);
      try {
        return ok("projectionState", deps.projection.state(command.subscriptionId));
      } catch (error) {
        return fail("projectionState", error instanceof Error ? error.message : String(error));
      }
    }

    case "projectionDropNext": {
      if (!deps.projection) return fail("projectionDropNext", PROJECTION_UNAVAILABLE);
      try {
        deps.projection.dropNext(command.subscriptionId, command.count);
        return ok("projectionDropNext");
      } catch (error) {
        return fail("projectionDropNext", error instanceof Error ? error.message : String(error));
      }
    }

    case "projectionResync": {
      if (!deps.projection) return fail("projectionResync", PROJECTION_UNAVAILABLE);
      try {
        return ok("projectionResync", await deps.projection.resync(command.subscriptionId));
      } catch (error) {
        return fail("projectionResync", error instanceof Error ? error.message : String(error));
      }
    }

    case "projectionUnsubscribe": {
      if (!deps.projection) return fail("projectionUnsubscribe", PROJECTION_UNAVAILABLE);
      try {
        deps.projection.unsubscribe(command.subscriptionId);
        return ok("projectionUnsubscribe");
      } catch (error) {
        return fail(
          "projectionUnsubscribe",
          error instanceof Error ? error.message : String(error)
        );
      }
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
