import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import {
  flushSessionRegion,
  installSessionLifecycleHarness,
  reconnecting,
} from "@/test/sessionLifecycleRegionTestHarness";

// Stub lucide-react icons used in the overlay
vi.mock("lucide-react", () => ({
  WifiOff: () => null,
  RefreshCw: () => null,
  X: () => null,
  AlertTriangle: () => null,
  Loader2: () => null,
  CheckCircle2: () => null,
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
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });

    expect(container.querySelector("[data-testid='terminal-disconnect-overlay']")).not.toBeNull();
    expect(container.textContent).toContain("Session disconnected");
  });

  it("renders reconnect and view-scrollback buttons", () => {
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
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
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
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
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
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
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
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

describe("TerminalDisconnectOverlay — exit-cause branching (#1121)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useAppStore.setState({
      terminalExitedTabs: { "tab-1": true },
      terminalExitInfo: {},
      terminalRetryCounters: {},
      terminalDisconnectErrors: {},
      terminalViewMode: {},
      terminalReconnectingTabs: {},
      terminalReconnectPrompt: {},
      terminalReconnectTriggerErrors: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows a clean-exit heading for a normal exit (code 0)", () => {
    useAppStore.setState({
      terminalExitInfo: { "tab-1": { code: 0, reason: "clean" } },
    });

    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });

    expect(container.textContent).toContain("Session ended");
    // Must NOT read as an unexpected disconnect.
    expect(container.textContent).not.toContain("The remote process has exited");
  });

  it("shows a non-zero exit-code heading and surfaces the code", () => {
    useAppStore.setState({
      terminalExitInfo: { "tab-1": { code: 137, reason: "dropped" } },
    });

    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });

    expect(container.textContent).toContain("Session disconnected");
    expect(container.textContent).toContain("137");
    // Non-zero exit is not a clean exit.
    expect(container.textContent).not.toContain("Session ended");
  });

  it("shows a peer-drop message when the exit code is unknown (null)", () => {
    useAppStore.setState({
      terminalExitInfo: { "tab-1": { code: null, reason: "dropped" } },
    });

    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });

    expect(container.textContent).toContain("Session disconnected");
    // Distinct wording from the clean-exit variant.
    expect(container.textContent).toContain("connection was lost");
  });

  it("falls back to the generic disconnect heading when no exit info is present", () => {
    // No terminalExitInfo entry — legacy behaviour.
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });

    expect(container.textContent).toContain("Session disconnected");
    expect(container.textContent).toContain("The remote process has exited");
  });
});

describe("TerminalDisconnectOverlay — reconnecting state", () => {
  // The reconnecting flag + trigger error are now sourced purely from the
  // projected `session-lifecycle` region (#2205), so seed the region rather than
  // the removed `appStore` slices. A `connecting`-phase reconnect drives the
  // reconnecting-spinner variant (a `waiting` phase would show the countdown).
  const harness = installSessionLifecycleHarness();

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
      terminalReconnectTriggerErrors: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows reconnecting heading and a stop button", async () => {
    harness.transport.setSession(
      "tab-1",
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 })
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    await flushSessionRegion();

    expect(container.textContent).toContain("Reconnecting");
    expect(container.querySelector("[data-testid='terminal-disconnect-stop-btn']")).not.toBeNull();
    expect(container.querySelector("[data-testid='terminal-disconnect-reconnect-btn']")).toBeNull();
    expect(container.querySelector("[data-testid='terminal-disconnect-view-btn']")).toBeNull();
  });

  it("stop button transitions tab from reconnecting to exited", async () => {
    harness.transport.setSession(
      "tab-1",
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 })
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    await flushSessionRegion();

    const btn = container.querySelector(
      "[data-testid='terminal-disconnect-stop-btn']"
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    const state = useAppStore.getState();
    expect(state.terminalReconnectingTabs["tab-1"]).toBeUndefined();
    expect(state.terminalExitedTabs["tab-1"]).toBe(true);
  });

  it("shows trigger error when the region carries a reconnect-trigger cause for the tab", async () => {
    harness.transport.setSession(
      "tab-1",
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 }, "Connection lost: broken pipe")
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    await flushSessionRegion();

    expect(
      container.querySelector("[data-testid='terminal-disconnect-trigger-error-box']")
    ).not.toBeNull();
    expect(container.textContent).toContain("Connection lost: broken pipe");
  });

  it("does not show trigger error box when no error is set", async () => {
    harness.transport.setSession(
      "tab-1",
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 })
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    await flushSessionRegion();

    expect(
      container.querySelector("[data-testid='terminal-disconnect-trigger-error-box']")
    ).toBeNull();
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
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });

    expect(container.textContent).toContain("Reconnect failed");
    expect(container.textContent).toContain("Failed to reconnect after 10 attempts");
    expect(container.querySelector("[data-testid='terminal-disconnect-error-box']")).not.toBeNull();
  });

  it("try-again button clears error and increments retry counter", () => {
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
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
      terminalExitInfo: {},
      intentionallyKilledSessions: {},
      terminalRetryCounters: {},
      terminalDisconnectErrors: {},
      terminalViewMode: {},
      terminalReconnectingTabs: {},
      terminalReconnectPrompt: {},
      terminalReconnectTriggerErrors: {},
    });
  });

  it("setTerminalExited marks a tab as exited", () => {
    useAppStore.getState().setTerminalExited("tab-42");
    expect(useAppStore.getState().terminalExitedTabs["tab-42"]).toBe(true);
  });

  it("setTerminalExited records exit info (code + reason) when provided (#1121)", () => {
    useAppStore.getState().setTerminalExited("tab-42", { code: 0, reason: "clean" });
    const info = useAppStore.getState().terminalExitInfo["tab-42"];
    expect(info).toEqual({ code: 0, reason: "clean" });
  });

  it("setTerminalExited records a non-zero exit code with a dropped reason (#1121)", () => {
    useAppStore.getState().setTerminalExited("tab-42", { code: 137, reason: "dropped" });
    expect(useAppStore.getState().terminalExitInfo["tab-42"]).toEqual({
      code: 137,
      reason: "dropped",
    });
  });

  it("setTerminalExited with a killed reason enters view mode so no overlay is shown (#1121)", () => {
    useAppStore.getState().setTerminalExited("tab-42", { code: null, reason: "killed" });
    const state = useAppStore.getState();
    // Session is marked dead...
    expect(state.terminalExitedTabs["tab-42"]).toBe(true);
    // ...but view mode is set, so `isExited && !isViewMode` is false and the
    // "unexpected disconnect" overlay never appears.
    expect(state.terminalViewMode["tab-42"]).toBe(true);
    expect(state.terminalExitInfo["tab-42"]).toEqual({ code: null, reason: "killed" });
  });

  it("setTerminalExited without info leaves no exit info entry (legacy fallback) (#1121)", () => {
    useAppStore.getState().setTerminalExited("tab-42");
    expect(useAppStore.getState().terminalExitInfo["tab-42"]).toBeUndefined();
    // A non-killed exit must not force view mode.
    expect(useAppStore.getState().terminalViewMode["tab-42"]).toBeUndefined();
  });

  it("markSessionKilled + consumeSessionKilled tags a user kill exactly once (#1121)", () => {
    const store = useAppStore.getState();
    store.markSessionKilled("sess-1");
    // First consume reports the kill and clears the flag.
    expect(useAppStore.getState().consumeSessionKilled("sess-1")).toBe(true);
    // Second consume for the same session is not a kill anymore.
    expect(useAppStore.getState().consumeSessionKilled("sess-1")).toBe(false);
  });

  it("consumeSessionKilled returns false for an unmarked session (#1121)", () => {
    expect(useAppStore.getState().consumeSessionKilled("never-marked")).toBe(false);
  });

  it("setTerminalExited clears any stale reconnecting flag", () => {
    useAppStore.setState({ terminalReconnectingTabs: { "tab-42": true } });
    useAppStore.getState().setTerminalExited("tab-42");
    expect(useAppStore.getState().terminalReconnectingTabs["tab-42"]).toBeUndefined();
  });

  it("setTerminalExited clears the reconnect trigger error", () => {
    useAppStore.setState({ terminalReconnectTriggerErrors: { "tab-42": "broken pipe" } });
    useAppStore.getState().setTerminalExited("tab-42");
    expect(useAppStore.getState().terminalReconnectTriggerErrors["tab-42"]).toBeUndefined();
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

  it("setTerminalReconnecting clears trigger error when stopping", () => {
    useAppStore.setState({
      terminalReconnectingTabs: { "tab-42": true },
      terminalReconnectTriggerErrors: { "tab-42": "broken pipe" },
    });
    useAppStore.getState().setTerminalReconnecting("tab-42", false);
    expect(useAppStore.getState().terminalReconnectTriggerErrors["tab-42"]).toBeUndefined();
  });

  it("setTerminalReconnectTriggerError sets the trigger error for a tab", () => {
    useAppStore.getState().setTerminalReconnectTriggerError("tab-42", "broken pipe");
    expect(useAppStore.getState().terminalReconnectTriggerErrors["tab-42"]).toBe("broken pipe");
  });

  it("setTerminalReconnectTriggerError clears the error when passed null", () => {
    useAppStore.setState({ terminalReconnectTriggerErrors: { "tab-42": "some error" } });
    useAppStore.getState().setTerminalReconnectTriggerError("tab-42", null);
    expect(useAppStore.getState().terminalReconnectTriggerErrors["tab-42"]).toBeUndefined();
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
      terminalReconnectTriggerErrors: { "tab-42": "trigger error" },
    });
    useAppStore.getState().reconnectTerminal("tab-42");

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs["tab-42"]).toBeUndefined();
    expect(state.terminalDisconnectErrors["tab-42"]).toBeUndefined();
    expect(state.terminalViewMode["tab-42"]).toBeUndefined();
    expect(state.terminalReconnectPrompt["tab-42"]).toBeUndefined();
    expect(state.terminalReconnectingTabs["tab-42"]).toBeUndefined();
    expect(state.terminalReconnectTriggerErrors["tab-42"]).toBeUndefined();
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
