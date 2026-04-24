import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { useAppStore } from "@/store/appStore";

// Stub lucide-react icons used in the overlay
vi.mock("lucide-react", () => ({
  WifiOff: () => null,
  RefreshCw: () => null,
  X: () => null,
  AlertTriangle: () => null,
  Loader2: () => null,
}));

describe("TerminalDisconnectOverlay — default (disconnected) state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useAppStore.setState({
      terminalExitedTabs: {},
      terminalRetryCounters: {},
      terminalDisconnectErrors: {},
      terminalViewMode: {},
      terminalReconnectingTabs: {},
      terminalReconnectPrompt: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the overlay with the disconnected heading", () => {
    act(() => {
      root.render(<TerminalDisconnectOverlay tabId="tab-1" />);
    });

    expect(container.querySelector("[data-testid='terminal-disconnect-overlay']")).not.toBeNull();
    expect(container.textContent).toContain("Session disconnected");
  });

  it("renders reconnect and view-scrollback buttons", () => {
    act(() => {
      root.render(<TerminalDisconnectOverlay tabId="tab-1" />);
    });

    expect(
      container.querySelector("[data-testid='terminal-disconnect-reconnect-btn']")
    ).not.toBeNull();
    expect(container.querySelector("[data-testid='terminal-disconnect-view-btn']")).not.toBeNull();
    expect(
      container.querySelector("[data-testid='terminal-disconnect-dismiss-btn']")
    ).not.toBeNull();
  });

  it("reconnect button clears exited flag and increments retry counter", () => {
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

  it("view-scrollback button enters view mode (keeps exited flag, sets viewMode)", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-1": true }, terminalRetryCounters: {} });

    act(() => {
      root.render(<TerminalDisconnectOverlay tabId="tab-1" />);
    });

    const btn = container.querySelector(
      "[data-testid='terminal-disconnect-view-btn']"
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    const state = useAppStore.getState();
    // Session is still marked exited — banner will show instead of overlay
    expect(state.terminalExitedTabs["tab-1"]).toBe(true);
    // View mode flag is set
    expect(state.terminalViewMode["tab-1"]).toBe(true);
    // Retry counter unchanged
    expect(state.terminalRetryCounters["tab-1"]).toBeUndefined();
  });

  it("dismiss button (×) also enters view mode", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-1": true } });

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
    expect(state.terminalExitedTabs["tab-1"]).toBe(true);
    expect(state.terminalViewMode["tab-1"]).toBe(true);
  });
});

describe("TerminalDisconnectOverlay — reconnecting state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useAppStore.setState({
      terminalExitedTabs: {},
      terminalRetryCounters: {},
      terminalDisconnectErrors: {},
      terminalViewMode: {},
      terminalReconnectingTabs: { "tab-1": true },
      terminalReconnectPrompt: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows reconnecting heading and no action buttons", () => {
    act(() => {
      root.render(<TerminalDisconnectOverlay tabId="tab-1" />);
    });

    expect(container.textContent).toContain("Reconnecting");
    expect(container.querySelector("[data-testid='terminal-disconnect-reconnect-btn']")).toBeNull();
    expect(container.querySelector("[data-testid='terminal-disconnect-view-btn']")).toBeNull();
  });
});

describe("TerminalDisconnectOverlay — error (reconnect failed) state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useAppStore.setState({
      terminalExitedTabs: { "tab-1": true },
      terminalRetryCounters: {},
      terminalDisconnectErrors: { "tab-1": "Failed to reconnect after 10 attempts" },
      terminalViewMode: {},
      terminalReconnectingTabs: {},
      terminalReconnectPrompt: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows error heading and the error message", () => {
    act(() => {
      root.render(<TerminalDisconnectOverlay tabId="tab-1" />);
    });

    expect(container.textContent).toContain("Reconnect failed");
    expect(container.textContent).toContain("Failed to reconnect after 10 attempts");
    expect(container.querySelector("[data-testid='terminal-disconnect-error-box']")).not.toBeNull();
  });

  it("try-again button clears error and increments retry counter", () => {
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
    expect(state.terminalDisconnectErrors["tab-1"]).toBeUndefined();
    expect(state.terminalRetryCounters["tab-1"]).toBe(1);
  });
});

describe("appStore disconnect actions", () => {
  beforeEach(() => {
    useAppStore.setState({
      terminalExitedTabs: {},
      terminalRetryCounters: {},
      terminalDisconnectErrors: {},
      terminalViewMode: {},
      terminalReconnectingTabs: {},
      terminalReconnectPrompt: {},
    });
  });

  it("setTerminalExited marks a tab as exited", () => {
    useAppStore.getState().setTerminalExited("tab-42");
    expect(useAppStore.getState().terminalExitedTabs["tab-42"]).toBe(true);
  });

  it("setTerminalExited clears any stale reconnecting flag", () => {
    useAppStore.setState({ terminalReconnectingTabs: { "tab-42": true } });
    useAppStore.getState().setTerminalExited("tab-42");
    expect(useAppStore.getState().terminalReconnectingTabs["tab-42"]).toBeUndefined();
  });

  it("setTerminalExited does not affect other tabs", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-1": true } });
    useAppStore.getState().setTerminalExited("tab-2");
    expect(useAppStore.getState().terminalExitedTabs["tab-1"]).toBe(true);
    expect(useAppStore.getState().terminalExitedTabs["tab-2"]).toBe(true);
  });

  it("setTerminalDisconnectWithError sets exited flag and error message", () => {
    useAppStore.getState().setTerminalDisconnectWithError("tab-42", "Connection refused");
    const state = useAppStore.getState();
    expect(state.terminalExitedTabs["tab-42"]).toBe(true);
    expect(state.terminalDisconnectErrors["tab-42"]).toBe("Connection refused");
  });

  it("setTerminalDisconnectWithError clears reconnecting flag", () => {
    useAppStore.setState({ terminalReconnectingTabs: { "tab-42": true } });
    useAppStore.getState().setTerminalDisconnectWithError("tab-42", "Timeout");
    expect(useAppStore.getState().terminalReconnectingTabs["tab-42"]).toBeUndefined();
  });

  it("setTerminalReconnecting sets and clears the reconnecting flag", () => {
    useAppStore.getState().setTerminalReconnecting("tab-42", true);
    expect(useAppStore.getState().terminalReconnectingTabs["tab-42"]).toBe(true);

    useAppStore.getState().setTerminalReconnecting("tab-42", false);
    expect(useAppStore.getState().terminalReconnectingTabs["tab-42"]).toBeUndefined();
  });

  it("dismissTerminalDisconnect enters view mode without clearing exited flag", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-42": true } });
    useAppStore.getState().dismissTerminalDisconnect("tab-42");
    const state = useAppStore.getState();
    expect(state.terminalExitedTabs["tab-42"]).toBe(true);
    expect(state.terminalViewMode["tab-42"]).toBe(true);
  });

  it("dismissTerminalDisconnect does not increment retry counter", () => {
    useAppStore.setState({ terminalExitedTabs: { "tab-42": true } });
    useAppStore.getState().dismissTerminalDisconnect("tab-42");
    expect(useAppStore.getState().terminalRetryCounters["tab-42"]).toBeUndefined();
  });

  it("reconnectTerminal clears all disconnect state and increments retry counter", () => {
    useAppStore.setState({
      terminalExitedTabs: { "tab-42": true },
      terminalDisconnectErrors: { "tab-42": "some error" },
      terminalViewMode: { "tab-42": true },
      terminalReconnectPrompt: { "tab-42": true },
      terminalReconnectingTabs: { "tab-42": true },
    });
    useAppStore.getState().reconnectTerminal("tab-42");

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs["tab-42"]).toBeUndefined();
    expect(state.terminalDisconnectErrors["tab-42"]).toBeUndefined();
    expect(state.terminalViewMode["tab-42"]).toBeUndefined();
    expect(state.terminalReconnectPrompt["tab-42"]).toBeUndefined();
    expect(state.terminalReconnectingTabs["tab-42"]).toBeUndefined();
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

  it("showTerminalReconnectPrompt sets the prompt flag", () => {
    useAppStore.getState().showTerminalReconnectPrompt("tab-42");
    expect(useAppStore.getState().terminalReconnectPrompt["tab-42"]).toBe(true);
  });

  it("dismissTerminalReconnectPrompt clears the prompt flag", () => {
    useAppStore.setState({ terminalReconnectPrompt: { "tab-42": true } });
    useAppStore.getState().dismissTerminalReconnectPrompt("tab-42");
    expect(useAppStore.getState().terminalReconnectPrompt["tab-42"]).toBeUndefined();
  });
});
