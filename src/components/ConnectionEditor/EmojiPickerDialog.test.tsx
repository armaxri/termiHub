/**
 * EmojiPickerDialog (#5008): the frimousse picker loads the bundled emoji
 * data (no network), filters by search, and picking an emoji reports it and
 * closes the dialog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EmojiPickerDialog } from "./EmojiPickerDialog";

let container: HTMLDivElement;
let root: Root;

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

const emojis = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="emoji-picker-emoji"]'));

describe("EmojiPickerDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders bundled emoji offline, searches, and applies a pick", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onEmojiSelect = vi.fn();
    const onOpenChange = vi.fn();
    act(() =>
      root.render(
        <EmojiPickerDialog open onOpenChange={onOpenChange} onEmojiSelect={onEmojiSelect} />
      )
    );
    await waitFor(() => emojis().length > 0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    setInput(
      document.querySelector('[data-testid="emoji-picker-search"]') as HTMLInputElement,
      "whale"
    );
    await waitFor(() => emojis().some((b) => b.textContent === "🐳"));
    act(() =>
      emojis()
        .find((b) => b.textContent === "🐳")!
        .click()
    );

    expect(onEmojiSelect).toHaveBeenCalledWith("🐳");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers a skin-tone selector", async () => {
    act(() =>
      root.render(<EmojiPickerDialog open onOpenChange={vi.fn()} onEmojiSelect={vi.fn()} />)
    );
    await waitFor(() => emojis().length > 0);
    expect(document.querySelector('[data-testid="emoji-picker-skin-tone"]')).not.toBeNull();
  });
});
