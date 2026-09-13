import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TerminalReconnectPrompt } from "./TerminalReconnectPrompt";

const reconnectTerminal = vi.fn();
const dismissTerminalReconnectPrompt = vi.fn();

vi.mock("@/store/appStore", () => {
  const state = {
    reconnectTerminal: (...args: unknown[]) => reconnectTerminal(...args),
    dismissTerminalReconnectPrompt: (...args: unknown[]) => dismissTerminalReconnectPrompt(...args),
  };
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
    root.render(<TerminalReconnectPrompt tabId={tabId} />);
  });
}

describe("TerminalReconnectPrompt", () => {
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

  it("renders the prompt with reconnect and stay actions", () => {
    render("tab-1");
    expect(query("terminal-reconnect-prompt")).not.toBeNull();
    expect(container.textContent).toContain("This session has ended");
    expect(query("terminal-reconnect-prompt-reconnect-btn")).not.toBeNull();
    expect(query("terminal-reconnect-prompt-stay-btn")).not.toBeNull();
  });

  it("reconnects the owning tab (and does not dismiss) on Reconnect", () => {
    render("tab-7");
    act(() => query("terminal-reconnect-prompt-reconnect-btn")?.click());
    expect(reconnectTerminal).toHaveBeenCalledWith("tab-7");
    expect(dismissTerminalReconnectPrompt).not.toHaveBeenCalled();
  });

  it("dismisses the prompt (and does not reconnect) on Stay in View Mode", () => {
    render("tab-9");
    act(() => query("terminal-reconnect-prompt-stay-btn")?.click());
    expect(dismissTerminalReconnectPrompt).toHaveBeenCalledWith("tab-9");
    expect(reconnectTerminal).not.toHaveBeenCalled();
  });
});
