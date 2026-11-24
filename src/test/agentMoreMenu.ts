/**
 * Test helper for a connected agent row's "…" menu (#5851): New folder,
 * Disconnect (detach), Shutdown (stop remote), … are its entries, which only
 * render while the menu is open.
 */
import { act } from "react";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Open agent `agentId`'s "…" menu (no-op when it is already open). */
export async function openAgentMoreMenu(agentId: string): Promise<void> {
  const menu = `[data-testid="agent-more-menu-${agentId}"]`;
  if (document.querySelector(menu)) return;
  const trigger = document.querySelector<HTMLButtonElement>(
    `[data-testid="agent-more-${agentId}"]`
  );
  if (!trigger) throw new Error(`no "…" menu trigger on agent ${agentId}`);
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
