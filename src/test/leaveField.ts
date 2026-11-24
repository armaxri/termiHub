import { act } from "react";

/**
 * Move focus out of a form control the way a user leaving the field does.
 *
 * Editors reveal a field's validation error once it was edited and then left
 * (`useRevealedErrors`, #5909/#5917). They listen with React's `onBlurCapture`,
 * which jsdom only fires for a bubbling `focusout`.
 */
export function leaveField(el: Element | null): void {
  if (!el) throw new Error("leaveField: no element to leave");
  act(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}
