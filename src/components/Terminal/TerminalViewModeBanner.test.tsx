import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TerminalViewModeBanner } from "./TerminalViewModeBanner";

const reconnectTerminal = vi.fn();

vi.mock("@/store/appStore", () => {
  const state = { reconnectTerminal: (...args: unknown[]) => reconnectTerminal(...args) };
  const useAppStore = (selector: (s: typeof state) => unknown) => selector(state);
  return { useAppStore };
});

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(tabId: string) {
  act(() => {
    root.render(<TerminalViewModeBanner tabId={tabId} />);
  });
}

describe("TerminalViewModeBanner", () => {
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

  it("renders the session-ended message and a reconnect button", () => {
    render("tab-1");
    expect(query("terminal-view-mode-banner")).not.toBeNull();
    expect(container.textContent).toContain("Session ended");
    expect(query("terminal-view-mode-reconnect-btn")).not.toBeNull();
  });

  it("reconnects the owning tab when the reconnect button is clicked", () => {
    render("tab-42");
    act(() => query("terminal-view-mode-reconnect-btn")?.click());
    expect(reconnectTerminal).toHaveBeenCalledTimes(1);
    expect(reconnectTerminal).toHaveBeenCalledWith("tab-42");
  });
});
