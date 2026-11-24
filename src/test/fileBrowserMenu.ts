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
  await waitFor(MENU);
}

/** Entries of a header menu button (#5832), by the test id of that button. */
const MENU_BUTTON_OF: Record<string, string> = {
  "file-browser-new-file": "file-browser-new",
  "file-browser-new-folder": "file-browser-new",
};

/** Wait (a few frames) until `selector` mounts. */
async function waitFor(selector: string): Promise<void> {
  for (let i = 0; i < 20 && !document.querySelector(selector); i++) {
    await act(async () => {
      await Promise.resolve();
      await nextFrame();
    });
  }
}

/**
 * Open the header menu button `testId` ("New ▾", #5832): its inline dropdown,
 * or — collapsed into the "…" menu at a narrow width — its sub-menu there.
 */
export async function openFileBrowserMenuButton(testId: string): Promise<void> {
  const selector = `[data-testid="${testId}"]`;
  const menu = `[data-testid="${testId}-menu"]`;
  if (document.querySelector(menu)) return;
  let trigger = document.querySelector<HTMLElement>(selector);
  if (!trigger) {
    await openFileBrowserMoreMenu();
    trigger = document.querySelector<HTMLElement>(selector);
  }
  if (!trigger) throw new Error(`no file-browser menu button ${testId}`);
  const key = trigger.tagName === "BUTTON" ? "Enter" : "ArrowRight";
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await waitFor(menu);
}

/**
 * The header action with `testId` — inline, from the opened overflow menu, or
 * from the opened menu button it belongs to ("New ▸ File"). Returns `null`
 * when the action exists in none of them.
 */
export async function findFileBrowserAction(testId: string): Promise<HTMLElement | null> {
  const selector = `[data-testid="${testId}"]`;
  const inline = document.querySelector<HTMLElement>(selector);
  if (inline) return inline;
  const parent = MENU_BUTTON_OF[testId];
  if (parent) await openFileBrowserMenuButton(parent);
  else await openFileBrowserMoreMenu();
  return document.querySelector<HTMLElement>(selector);
}

/** Whether an inline button or a menu entry is disabled. */
export function isActionDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}
