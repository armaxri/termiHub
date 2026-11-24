import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConnectionsEmptyState } from "./ConnectionsEmptyState";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(onNewConnection = vi.fn()) {
  act(() => {
    root.render(<ConnectionsEmptyState onNewConnection={onNewConnection} />);
  });
  return onNewConnection;
}

describe("ConnectionsEmptyState", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the zero-state title and a New Connection call-to-action", () => {
    render();
    expect(query("connections-empty-state")).not.toBeNull();
    expect(container.textContent).toContain("No connections yet");
    expect(query("connections-empty-new-connection")).not.toBeNull();
  });

  it("invokes onNewConnection when the New Connection button is clicked", () => {
    const onNewConnection = render();
    act(() => query("connections-empty-new-connection")?.click());
    expect(onNewConnection).toHaveBeenCalledTimes(1);
  });

  // #5954: the card is about connections only. The workflows note lives in the
  // Workflows view, so nothing here reads as if connections need a switch.
  it("never mentions experimental features or workflows", () => {
    render();
    const card = query("connections-empty-state")!;
    expect(card.textContent).not.toMatch(/experimental|workflow|turn on/i);
    expect(query("connections-empty-experimental-hint")).toBeNull();
    // The only button is the call-to-action.
    const buttons = card.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("data-testid")).toBe("connections-empty-new-connection");
  });

  it("keeps the compact line free of the experimental note", () => {
    act(() => {
      root.render(<ConnectionsEmptyState onNewConnection={vi.fn()} compact />);
    });
    expect(query("connections-empty-state")!.textContent).not.toMatch(/experimental|workflow/i);
  });

  it("has no stray punctuation-only text node (#5621)", () => {
    render();
    const walker = document.createTreeWalker(
      query("connections-empty-state")!,
      NodeFilter.SHOW_TEXT
    );
    const orphans: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      if (text !== "" && /^[.,;:]+$/.test(text)) orphans.push(text);
    }
    expect(orphans).toEqual([]);
  });
});
