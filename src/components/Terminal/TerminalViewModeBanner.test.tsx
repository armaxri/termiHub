import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TerminalViewModeBanner } from "./TerminalViewModeBanner";

const reconnectTerminal = vi.fn();

const agentDisconnected: Record<string, boolean> = vi.hoisted(() => ({}));

vi.mock("@/store/appStore", () => {
  const state = {
    reconnectTerminal: (...args: unknown[]) => reconnectTerminal(...args),
    terminalAgentDisconnected: agentDisconnected,
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
    root.render(<TerminalViewModeBanner tabId={tabId} />);
  });
}

describe("TerminalViewModeBanner", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    for (const key of Object.keys(agentDisconnected)) delete agentDisconnected[key];
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

  it("says the agent was disconnected when the user ended the agent (#4309)", () => {
    agentDisconnected["tab-7"] = true;
    render("tab-7");
    expect(container.textContent).toContain("Agent disconnected");
    expect(container.textContent).not.toContain("Session ended");
    expect(query("terminal-view-mode-reconnect-btn")).not.toBeNull();
  });

  it("reconnects the owning tab when the reconnect button is clicked", () => {
    render("tab-42");
    act(() => query("terminal-view-mode-reconnect-btn")?.click());
    expect(reconnectTerminal).toHaveBeenCalledTimes(1);
    expect(reconnectTerminal).toHaveBeenCalledWith("tab-42");
  });

  it("announces the agent disconnect politely in a live region (#4331)", () => {
    agentDisconnected["tab-8"] = true;
    render("tab-8");
    const region = container.querySelector("[role='status']");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toContain("Agent disconnected");
  });
});
