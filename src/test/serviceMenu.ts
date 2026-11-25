import { act } from "react";

/**
 * Open the "…" menu of the service row that `testId` belongs to
 * (`tunnel-delete-<id>`, `server-duplicate-<id>`, …) and return that item, or
 * `null` when the row or the item is not there.
 */
export function serviceMenuItem(testId: string): HTMLElement | null {
  const match = /^(tunnel|server)-[a-z]+-(.+)$/.exec(testId);
  const more = match && document.querySelector(`[data-testid="${match[1]}-more-${match[2]}"]`);
  if (!more) return null;
  act(() => {
    more.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })
    );
  });
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}
