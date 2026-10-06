/**
 * Replay an IME composition on a text control for the `compose` bridge verb (#3059).
 *
 * A real input method owns the preedit and the candidate window, which no
 * script can drive. What the app sees of it, though, is a fixed DOM sequence on
 * the focused control, and that is where duplicate or partial commits come
 * from: xterm's `CompositionHelper` and Monaco's `TextAreaInput` both read the
 * control's *value* around the composition events, not just `event.data`. This
 * replays that sequence the way Chromium/WebKit deliver it:
 *
 * 1. `keydown` with the IME key code 229 (`key: "Process"`);
 * 2. `compositionstart`;
 * 3. per preedit step: `keydown` 229, the control's value updated in place,
 *    `compositionupdate` (`data` = the preedit) and an `input` event
 *    (`inputType: "insertCompositionText"`, `isComposing: true`);
 * 4. the commit: the value updated to the committed text, the final `input`,
 *    then `compositionend` (`data` = the commit).
 *
 * Every keystroke yields a macrotask, as separate input events do, and a few
 * more follow the commit so handlers that defer to `setTimeout(0)` (xterm sends
 * the commit from one) have run before the verb answers.
 *
 * The preedit replaces the text the control had selected when the composition
 * started (the caret, usually), exactly where a real IME inserts it.
 */

/** IME "composition character" key code a browser reports while composing. */
const IME_KEY_CODE = 229;
/** Macrotasks to yield after `compositionend` so deferred commit handlers run. */
const SETTLE_TICKS = 3;

/** A control the composition can be replayed on. */
export type ComposableControl = HTMLTextAreaElement | HTMLInputElement;

/** Whether `el` is a control {@link replayComposition} can drive. */
export function isComposableControl(el: unknown): el is ComposableControl {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

/** Set a control's value through the native setter (bypassing React's tracker). */
function setNativeValue(el: ComposableControl, value: string): void {
  const prototype =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** Dispatch the IME `keydown` (key code 229) a browser sends for a composing keystroke. */
function dispatchImeKeydown(el: ComposableControl): void {
  const event = new KeyboardEvent("keydown", {
    key: "Process",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  // `keyCode` is read-only on KeyboardEventInit in some engines; pin it here.
  Object.defineProperty(event, "keyCode", { value: IME_KEY_CODE });
  Object.defineProperty(event, "which", { value: IME_KEY_CODE });
  el.dispatchEvent(event);
}

/** Dispatch a `composition*` event carrying `data`. */
function dispatchComposition(el: ComposableControl, type: string, data: string): void {
  el.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, cancelable: true }));
}

/** Dispatch the `input` event a browser fires after a composition edit. */
function dispatchCompositionInput(el: ComposableControl, data: string, isComposing: boolean): void {
  el.dispatchEvent(
    new InputEvent("input", {
      data,
      inputType: "insertCompositionText",
      isComposing,
      bubbles: true,
    })
  );
}

/** Resolve after `ticks` macrotasks. */
async function settle(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Replay a composition on `el`: preedit through each of `updates`, then commit
 * `commit`. Resolves once deferred commit handlers have had a chance to run.
 */
export async function replayComposition(
  el: ComposableControl,
  updates: readonly string[],
  commit: string
): Promise<void> {
  el.focus();
  el.dispatchEvent(new FocusEvent("focus"));

  const original = el.value;
  const start = el.selectionStart ?? original.length;
  const end = el.selectionEnd ?? start;
  const before = original.slice(0, start);
  const after = original.slice(end);
  const place = (text: string) => {
    setNativeValue(el, before + text + after);
    const caret = before.length + text.length;
    el.setSelectionRange?.(caret, caret);
  };

  // Each keystroke is its own task in a real browser, so yield between them:
  // handlers that defer with `setTimeout(0)` (xterm's) then run in the same
  // order relative to the next event as they do for a real IME.
  dispatchImeKeydown(el);
  dispatchComposition(el, "compositionstart", "");
  await settle(1);
  for (const preedit of updates) {
    dispatchImeKeydown(el);
    place(preedit);
    dispatchComposition(el, "compositionupdate", preedit);
    dispatchCompositionInput(el, preedit, true);
    await settle(1);
  }
  place(commit);
  dispatchCompositionInput(el, commit, true);
  dispatchComposition(el, "compositionend", commit);
  await settle(SETTLE_TICKS);
}
