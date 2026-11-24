import { act } from "react";

/** Open an automation row's "…" menu the way the keyboard does (Enter on it). */
export function openAutomationRowMenu(automationId: string): void {
  openMenu(`automation-more-${automationId}`);
}

/** Open a dropdown menu by its trigger's test id. */
export function openMenu(testId: string): void {
  const trigger = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!trigger) throw new Error(`no menu trigger ${testId}`);
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  });
}
