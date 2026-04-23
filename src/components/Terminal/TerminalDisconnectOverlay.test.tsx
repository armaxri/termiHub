import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { useAppStore } from "@/store/appStore";

// Stub lucide-react icons used in the overlay
vi.mock("lucide-react", () => ({
  WifiOff: () => null,
  RefreshCw: () => null,
  X: () => null,
}));

describe("TerminalDisconnectOverlay", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // Clear exited tabs state before each test
    useAppStore.setState({ terminalExitedTabs: {}, terminalRetryCounters: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the overlay with heading text", () => {
    act(() => {
      root.render(<TerminalDisconnectOverlay tabId="tab-1" />);
    });

    expect(container.querySelector("[data-testid='terminal-disconnect-overlay']")).not.toBeNull();
    expect(container.textContent).toContain("Session disconnected");
  });

  it("renders reconnect and dismiss buttons", () => {
    act(() => {
      root.render(<TerminalDisconnectOverlay tabId="tab-1" />);
    });

    expect(
      container.querySelector("[data-testid='terminal-disconnect-reconnect-btn']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='terminal-disconnect-dismiss-btn']")
    ).not.toBeNull();
  });

  it("reconnect button increments retry counter and clears exited flag", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-1": true } });

    act(() => {
      root.render(<TerminalDisconnectOverlay tabId="tab-1" />);
    });

    const btn = container.querySelector(
      "[data-testid='terminal-disconnect-reconnect-btn']"
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs["tab-1"]).toBeUndefined();
    expect(state.terminalRetryCounters["tab-1"]).toBe(1);
  });

  it("dismiss button clears exited flag without changing retry counter", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-1": true }, terminalRetryCounters: {} });

    act(() => {
      root.render(<TerminalDisconnectOverlay tabId="tab-1" />);
    });

    const btn = container.querySelector(
      "[data-testid='terminal-disconnect-dismiss-btn']"
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs["tab-1"]).toBeUndefined();
    expect(state.terminalRetryCounters["tab-1"]).toBeUndefined();
  });
});

describe("appStore disconnect actions", () => {
  beforeEach(() => {
    useAppStore.setState({ terminalExitedTabs: {}, terminalRetryCounters: {} });
  });

  it("setTerminalExited marks a tab as exited", () => {
    useAppStore.getState().setTerminalExited("tab-42");
    expect(useAppStore.getState().terminalExitedTabs["tab-42"]).toBe(true);
  });

  it("setTerminalExited does not affect other tabs", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-1": true } });
    useAppStore.getState().setTerminalExited("tab-2");
    expect(useAppStore.getState().terminalExitedTabs["tab-1"]).toBe(true);
    expect(useAppStore.getState().terminalExitedTabs["tab-2"]).toBe(true);
  });

  it("dismissTerminalDisconnect removes the exited flag", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-42": true } });
    useAppStore.getState().dismissTerminalDisconnect("tab-42");
    expect(useAppStore.getState().terminalExitedTabs["tab-42"]).toBeUndefined();
  });

  it("dismissTerminalDisconnect does not increment retry counter", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-42": true } });
    useAppStore.getState().dismissTerminalDisconnect("tab-42");
    expect(useAppStore.getState().terminalRetryCounters["tab-42"]).toBeUndefined();
  });

  it("reconnectTerminal removes the exited flag and increments retry counter", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-42": true } });
    useAppStore.getState().reconnectTerminal("tab-42");

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs["tab-42"]).toBeUndefined();
    expect(state.terminalRetryCounters["tab-42"]).toBe(1);
  });

  it("reconnectTerminal increments existing retry counter", () => {
    useAppStore.setState({
      terminalExitedTabs: { "tab-42": true },
      terminalRetryCounters: { "tab-42": 3 },
    });
    useAppStore.getState().reconnectTerminal("tab-42");
    expect(useAppStore.getState().terminalRetryCounters["tab-42"]).toBe(4);
  });

  it("reconnectTerminal does not affect other tabs", () => {
    useAppStore.setState({
      terminalExitedTabs: { "tab-1": true, "tab-2": true },
    });
    useAppStore.getState().reconnectTerminal("tab-1");
    expect(useAppStore.getState().terminalExitedTabs["tab-2"]).toBe(true);
  });
});
