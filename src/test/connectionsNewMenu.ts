/**
 * Test helper for the Saved header's "New ▾" menu (#5848): New connection,
 * New folder and Import connections… are its entries, which only render while
 * the menu is open (Radix portals them into `document.body`).
 */
import { act } from "react";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Open the Saved header's "New ▾" menu (no-op when it is already open). */
export async function openConnectionsNewMenu(): Promise<void> {
  const menu = '[data-testid="connection-list-new-menu-content"]';
  if (document.querySelector(menu)) return;
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-testid="connection-list-new-menu"]'
  );
  if (!trigger) throw new Error('no "New" menu trigger in the Saved header');
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  });
  for (let i = 0; i < 20 && !document.querySelector(menu); i++) {
    await act(async () => {
      await Promise.resolve();
      await nextFrame();
    });
  }
}

/** Open the "New ▾" menu and pick the entry with test id `testId`. */
export async function pickConnectionsNewMenuItem(testId: string): Promise<void> {
  await openConnectionsNewMenu();
  const item = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!item) throw new Error(`no "${testId}" entry in the "New" menu`);
  await act(async () => {
    item.focus();
    item.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
      await nextFrame();
    });
  }
}
