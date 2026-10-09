import { act } from "react";

/**
 * Press an arrow key on a focused radio the way a user would (keydown then
 * keyup, bubbling to `document`). Radix RadioGroup's roving focus moves focus
 * to the next radio and — because an arrow key is held — selects it, so this
 * exercises the real keyboard path rather than a synthetic `click()`.
 *
 * Radix moves focus inside a `setTimeout`, so the helper flushes a macrotask
 * before releasing the key.
 */
export async function pressRadioArrow(
  el: HTMLElement,
  key: "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight"
): Promise<void> {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  });
}
