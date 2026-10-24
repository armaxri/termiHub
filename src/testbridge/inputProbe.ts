/**
 * Record the input events that reach the document, for OS-level input grades
 * (#4935).
 *
 * The harness injects real OS input (XTEST on Xvfb, `CGEventPostToPid` on macOS,
 * `SendInput` on Windows) aimed at the test instance's PID. To turn a screen
 * coordinate into a DOM element, and to prove the events really came from the OS
 * rather than from the bridge's own synthetic dispatch, it needs to see what the
 * webview received: `isTrusted`, the client/screen coordinates, the key and the
 * modifier state (`CapsLock` included).
 *
 * The probe is armed lazily by the first `osInputProbe` command and records in
 * the capture phase, so no app handler can hide an event from it. It only ever
 * runs in a test-bridge build.
 */

import type { OsInputProbeEvent } from "./protocol";

/** How many recent events the probe keeps (oldest dropped first). */
export const INPUT_PROBE_CAPACITY = 64;

const RECORDED_TYPES = [
  "keydown",
  "keyup",
  "pointerdown",
  "pointerup",
  "pointermove",
  "contextmenu",
] as const;

interface ProbeState {
  doc: Document;
  events: OsInputProbeEvent[];
  listener: (event: Event) => void;
}

let state: ProbeState | null = null;

function modifierState(event: KeyboardEvent | MouseEvent, key: string): boolean {
  return typeof event.getModifierState === "function" ? event.getModifierState(key) : false;
}

/** The serializable record of one DOM input event. */
export function describeInputEvent(event: Event): OsInputProbeEvent {
  const record: OsInputProbeEvent = {
    type: event.type,
    isTrusted: event.isTrusted,
    timeStamp: Math.round(event.timeStamp),
  };
  const target = event.target as Element | null;
  const testId = target?.closest?.("[data-testid]")?.getAttribute("data-testid");
  if (testId) record.testId = testId;
  if ("key" in event) {
    const key = event as KeyboardEvent;
    record.key = key.key;
    record.code = key.code;
    record.capsLock = modifierState(key, "CapsLock");
    record.ctrl = key.ctrlKey;
    record.meta = key.metaKey;
    record.alt = key.altKey;
    record.shift = key.shiftKey;
    record.repeat = key.repeat;
  } else if ("clientX" in event) {
    const mouse = event as MouseEvent;
    record.clientX = mouse.clientX;
    record.clientY = mouse.clientY;
    record.screenX = mouse.screenX;
    record.screenY = mouse.screenY;
    record.button = mouse.button;
    record.capsLock = modifierState(mouse, "CapsLock");
  }
  return record;
}

/** Arm the probe on `doc` (idempotent); `reset` clears what it recorded so far. */
export function armInputProbe(doc: Document, reset: boolean): void {
  if (state && state.doc !== doc) disarmInputProbe();
  if (!state) {
    const events: OsInputProbeEvent[] = [];
    const listener = (event: Event) => {
      events.push(describeInputEvent(event));
      if (events.length > INPUT_PROBE_CAPACITY) events.shift();
    };
    for (const type of RECORDED_TYPES) {
      doc.addEventListener(type, listener, { capture: true, passive: true });
    }
    state = { doc, events, listener };
  } else if (reset) {
    state.events.length = 0;
  }
}

/** The events recorded since the probe was armed or last reset (oldest first). */
export function inputProbeEvents(): OsInputProbeEvent[] {
  return state ? [...state.events] : [];
}

/** Remove the probe's listeners (tests and a document swap). */
export function disarmInputProbe(): void {
  if (!state) return;
  for (const type of RECORDED_TYPES) {
    state.doc.removeEventListener(type, state.listener, { capture: true });
  }
  state = null;
}
