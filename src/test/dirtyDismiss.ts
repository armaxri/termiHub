import { act } from "react";

/**
 * Shared drivers for the dirty-dismiss regression tests (UX2-004, #4314): each
 * dismiss path a Modal-based editor dialog can be closed by, plus the input
 * helper that makes a form dirty the way a real keystroke would.
 */

/** Query by `data-testid`, including content portalled to `document.body`. */
export const byTestId = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Type into a controlled input so React and react-hook-form see the change. */
export function typeInto(testId: string, value: string): void {
  const input = byTestId(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Press Escape with focus inside the element `fromTestId`. */
export function pressEscape(fromTestId: string): void {
  const el = byTestId(fromTestId)!;
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
  });
}

/** Press on a dialog's scrim (`<modal-testid>-overlay`), the click-outside path. */
export function clickScrim(modalTestId: string): void {
  const overlay = byTestId(`${modalTestId}-overlay`)!;
  act(() => {
    overlay.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
}

/** Click the element `testId`. */
export function click(testId: string): void {
  act(() => byTestId(testId)!.click());
}

/** Whether the shared unsaved-changes prompt is open. */
export const unsavedPromptOpen = (): boolean => byTestId("unsaved-changes-just-close") !== null;
