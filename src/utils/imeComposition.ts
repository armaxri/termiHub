/**
 * Shared IME-composition guard for Enter / Escape keyboard handlers (#3767).
 *
 * `KeyboardEvent.isComposing` alone is not enough:
 *
 * - WebKit (WKWebView on macOS, WebKitGTK on Linux) fires `compositionend`
 *   *before* the `keydown` of the Enter that confirms a candidate, so that
 *   keydown arrives with `isComposing === false` (it does carry the legacy
 *   `keyCode === 229` "IME is processing" marker).
 * - An Escape that cancels a preedit can reach the page as `key === "Escape"`.
 *
 * This module therefore tracks composition state explicitly with window-level
 * capture listeners and treats a keydown as composing when any of these hold:
 *
 * 1. `isComposing` is set (Chromium / WebView2 order);
 * 2. `keyCode === 229` (the IME is processing the key);
 * 3. a composition is active on the keydown's target
 *    (`compositionstart` seen, `compositionend` not yet seen);
 * 4. it is the first keydown immediately following a `compositionend`
 *    (WebKit order) — "immediately" meaning within
 *    {@link POST_COMPOSITION_KEYDOWN_WINDOW_MS}, so a deliberate follow-up
 *    Enter in the Chromium order still acts normally.
 *
 * Every text-field Enter/Escape handler should bail out early with
 * `if (isImeComposing(e)) return;` instead of re-implementing the check.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * How long after `compositionend` the next keydown still counts as part of the
 * composition. WebKit dispatches the confirming keydown back-to-back with
 * `compositionend`; a human's deliberate second Enter is far slower than this.
 */
export const POST_COMPOSITION_KEYDOWN_WINDOW_MS = 100;

/** Element whose composition is in progress, or `null` when none is. */
let compositionTarget: EventTarget | null = null;
/** `performance.now()` of the last `compositionend` whose keydown is pending. */
let compositionEndedAt: number | null = null;
/** Native keydowns classified as composition keys by the capture listener. */
let compositionKeydowns = new WeakSet<Event>();
let installed = false;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function onCompositionStart(e: Event): void {
  compositionTarget = e.target;
  compositionEndedAt = null;
}

function onCompositionEnd(): void {
  compositionTarget = null;
  compositionEndedAt = now();
}

function onKeyDownCapture(e: Event): void {
  if (compositionEndedAt === null) return;
  if (now() - compositionEndedAt <= POST_COMPOSITION_KEYDOWN_WINDOW_MS) {
    compositionKeydowns.add(e);
  }
  // Only the single keydown immediately after compositionend is affected.
  compositionEndedAt = null;
}

function onFocusOut(e: Event): void {
  // A composition never survives its field losing focus; don't let a missing
  // compositionend leave the flag stuck on.
  if (e.target === compositionTarget) compositionTarget = null;
}

/**
 * Install the window-level composition listeners (idempotent). Runs on module
 * load in a browser.
 */
function installImeCompositionTracker(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // Capture phase on window runs before every other keydown listener,
  // including Radix's document-level Escape handler and React's root listener.
  window.addEventListener("compositionstart", onCompositionStart, true);
  window.addEventListener("compositionend", onCompositionEnd, true);
  window.addEventListener("keydown", onKeyDownCapture, true);
  window.addEventListener("focusout", onFocusOut, true);
}

/** Test-only: clear tracked composition state between cases. */
export function resetImeCompositionTrackerForTests(): void {
  compositionTarget = null;
  compositionEndedAt = null;
  compositionKeydowns = new WeakSet<Event>();
}

/**
 * True when this keydown belongs to an IME composition (see the module doc)
 * and must not trigger Enter-to-submit, Escape-to-cancel or similar actions.
 * Accepts both React synthetic and native keyboard events.
 */
export function isImeComposing(e: KeyboardEvent | ReactKeyboardEvent): boolean {
  const native: KeyboardEvent = "nativeEvent" in e ? e.nativeEvent : e;
  if (native.isComposing || native.keyCode === 229) return true;
  if (compositionTarget !== null && compositionTarget === native.target) return true;
  return compositionKeydowns.has(native);
}

installImeCompositionTracker();
