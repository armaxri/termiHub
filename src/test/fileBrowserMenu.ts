/**
 * Test helpers for the file browser's "…" overflow menu (#5520): most header
 * actions are entries of that menu, which only renders while it is open.
 */
import { act } from "react";

const TRIGGER = '[data-testid="file-browser-more-actions"]';
const MENU = '[data-testid="file-browser-more-menu"]';

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Open the file browser's overflow menu (no-op when it is already open). */
export async function openFileBrowserMoreMenu(): Promise<void> {
  if (document.querySelector(MENU)) return;
  const trigger = document.querySelector<HTMLButtonElement>(TRIGGER);
  if (!trigger) throw new Error("no file-browser overflow trigger");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  });
  for (let i = 0; i < 20 && !document.querySelector(MENU); i++) {
    await act(async () => {
      await Promise.resolve();
      await nextFrame();
    });
  }
}

/**
 * The header action with `testId` — inline, or from the opened overflow menu.
 * Returns `null` when the action exists in neither.
 */
export async function findFileBrowserAction(testId: string): Promise<HTMLElement | null> {
  const selector = `[data-testid="${testId}"]`;
  const inline = document.querySelector<HTMLElement>(selector);
  if (inline) return inline;
  await openFileBrowserMoreMenu();
  return document.querySelector<HTMLElement>(selector);
}

/** Whether an inline button or a menu entry is disabled. */
export function isActionDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}
