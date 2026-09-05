import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import { currentSessionView, regionExited } from "@/store/sessionBridge";
import {
  connected,
  disconnected,
  failed,
  flushSessionRegion,
  installSessionLifecycleHarness,
  reconnecting,
  withExit,
} from "@/test/sessionLifecycleRegionTestHarness";

// The disconnect overlay renders purely from the projected `session-lifecycle`
// region now the per-client `terminalExitedTabs` / `terminalExitInfo` /
// `terminalDisconnectErrors` slices are deleted (#2625): the variant is chosen by
// the region status (`failed` → "Reconnect failed", `sessionLost` → "Session
// lost") and the region `exit` metadata (clean / dropped wording). Seed the region
// via the harness rather than the removed slices.
const TAB = "tab-1";

// Stub lucide-react icons used in the overlay
vi.mock("lucide-react", () => ({
  WifiOff: () => null,
  RefreshCw: () => null,
  X: () => null,
  AlertTriangle: () => null,
  Loader2: () => null,
  CheckCircle2: () => null,
  Unplug: () => null,
  Plus: () => null,
}));

// One region double for every test in this file; also gives the store actions a
// transport so their optimistic `session.*` folds land in `currentSessionView()`.
const harness = installSessionLifecycleHarness();

describe("TerminalDisconnectOverlay — default (disconnected) state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useAppStore.setState({
      terminalRetryCounters: {},
      terminalViewMode: {},
      terminalReconnectPrompt: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the overlay with the disconnected heading", async () => {
    harness.transport.setSession(TAB, disconnected());
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    expect(container.querySelector("[data-testid='terminal-disconnect-overlay']")).not.toBeNull();
    expect(container.textContent).toContain("Session disconnected");
  });

  it("renders reconnect and view-scrollback buttons", async () => {
    harness.transport.setSession(TAB, disconnected());
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    expect(
      container.querySelector("[data-testid='terminal-disconnect-reconnect-btn']")
    ).not.toBeNull();
    expect(container.querySelector("[data-testid='terminal-disconnect-view-btn']")).not.toBeNull();
    expect(
      container.querySelector("[data-testid='terminal-disconnect-dismiss-btn']")
    ).not.toBeNull();
  });

  it("reconnect button increments the retry counter", async () => {
    harness.transport.setSession(TAB, disconnected());
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    const btn = container.querySelector(
      "[data-testid='terminal-disconnect-reconnect-btn']"
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    // Re-driving the tab is now observed via the retry counter (the exited state
    // clears through the region once the fresh connect dispatches `session.connect`).
    expect(useAppStore.getState().terminalRetryCounters[TAB]).toBe(1);
  });

  it("view-scrollback button enters view mode", async () => {
    harness.transport.setSession(TAB, disconnected());
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    const btn = container.querySelector(
      "[data-testid='terminal-disconnect-view-btn']"
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    const state = useAppStore.getState();
    // View mode flag is set; the region keeps the tab exited so the banner shows.
    expect(state.terminalViewMode[TAB]).toBe(true);
    expect(regionExited(currentSessionView()[TAB])).toBe(true);
    // Retry counter unchanged.
    expect(state.terminalRetryCounters[TAB]).toBeUndefined();
  });

  it("dismiss button (×) also enters view mode", async () => {
    harness.transport.setSession(TAB, disconnected());
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    const btn = container.querySelector(
      "[data-testid='terminal-disconnect-dismiss-btn']"
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    const state = useAppStore.getState();
    expect(regionExited(currentSessionView()[TAB])).toBe(true);
    expect(state.terminalViewMode[TAB]).toBe(true);
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
      terminalRetryCounters: {},
      terminalViewMode: {},
      terminalReconnectPrompt: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows a clean-exit heading for a normal exit (code 0)", async () => {
    // A clean exit fires only `session.exited` — the region keeps its status and
    // records the cause solely as `exit`.
    harness.transport.setSession(TAB, withExit(connected(), { code: 0, reason: "clean" }));
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    expect(container.textContent).toContain("Session ended");
    // Must NOT read as an unexpected disconnect.
    expect(container.textContent).not.toContain("The remote process has exited");
  });

  it("shows a non-zero exit-code heading and surfaces the code", async () => {
    harness.transport.setSession(
      TAB,
      withExit(disconnected("unexpected"), { code: 137, reason: "dropped" })
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    expect(container.textContent).toContain("Session disconnected");
    expect(container.textContent).toContain("137");
    // Non-zero exit is not a clean exit.
    expect(container.textContent).not.toContain("Session ended");
  });

  it("shows a peer-drop message when the exit code is unknown (null)", async () => {
    harness.transport.setSession(
      TAB,
      withExit(disconnected("unexpected"), { code: null, reason: "dropped" })
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    expect(container.textContent).toContain("Session disconnected");
    // Distinct wording from the clean-exit variant.
    expect(container.textContent).toContain("connection was lost");
  });

  it("falls back to the generic disconnect heading when no exit info is present", async () => {
    // Disconnected with no recorded `exit` — the legacy generic wording.
    harness.transport.setSession(TAB, disconnected());
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    expect(container.textContent).toContain("Session disconnected");
    expect(container.textContent).toContain("The remote process has exited");
  });
});

describe("TerminalDisconnectOverlay — reconnecting state", () => {
  // The reconnecting flag + trigger error are sourced purely from the projected
  // `session-lifecycle` region (#2205), so seed the region. A `connecting`-phase
  // reconnect drives the reconnecting-spinner variant (a `waiting` phase would show
  // the countdown).
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useAppStore.setState({
      terminalRetryCounters: {},
      terminalViewMode: {},
      terminalReconnectPrompt: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows reconnecting heading and a stop button", async () => {
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 })
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    expect(container.textContent).toContain("Reconnecting");
    expect(container.querySelector("[data-testid='terminal-disconnect-stop-btn']")).not.toBeNull();
    expect(container.querySelector("[data-testid='terminal-disconnect-reconnect-btn']")).toBeNull();
    expect(container.querySelector("[data-testid='terminal-disconnect-view-btn']")).toBeNull();
  });

  it("stop button dispatches session.cancelReconnect to the region", async () => {
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 })
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    const btn = container.querySelector(
      "[data-testid='terminal-disconnect-stop-btn']"
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    // The reconnecting state lives in the region (#2205 PR-B) and the exited state
    // is region-only (#2625); the observable of Stop is the cancel intent dispatch.
    expect(
      harness.transport.dispatched.some(
        (i) =>
          i.kind === "session.cancelReconnect" &&
          (i.payload as { sessionId: string }).sessionId === TAB
      )
    ).toBe(true);
  });

  it("shows trigger error when the region carries a reconnect-trigger cause for the tab", async () => {
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 }, "Connection lost: broken pipe")
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    expect(
      container.querySelector("[data-testid='terminal-disconnect-trigger-error-box']")
    ).not.toBeNull();
    expect(container.textContent).toContain("Connection lost: broken pipe");
  });

  it("does not show trigger error box when no error is set", async () => {
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 })
    );
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
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
      terminalRetryCounters: {},
      terminalViewMode: {},
      terminalReconnectPrompt: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows error heading and the error message", async () => {
    harness.transport.setSession(TAB, failed("Failed to reconnect after 10 attempts"));
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    expect(container.textContent).toContain("Reconnect failed");
    expect(container.textContent).toContain("Failed to reconnect after 10 attempts");
    expect(container.querySelector("[data-testid='terminal-disconnect-error-box']")).not.toBeNull();
  });

  it("try-again button increments the retry counter", async () => {
    harness.transport.setSession(TAB, failed("Failed to reconnect after 10 attempts"));
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />));
    });
    await flushSessionRegion();

    const btn = container.querySelector(
      "[data-testid='terminal-disconnect-reconnect-btn']"
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    // The error clears through the region on the fresh connect; the observable here
    // is the retry counter bump.
    expect(useAppStore.getState().terminalRetryCounters[TAB]).toBe(1);
  });
});

describe("appStore disconnect actions", () => {
  beforeEach(() => {
    useAppStore.setState({
      intentionallyKilledSessions: {},
      terminalRetryCounters: {},
      terminalViewMode: {},
      terminalReconnectPrompt: {},
    });
  });

  it("setTerminalExited marks a tab as exited in the region", () => {
    useAppStore.getState().setTerminalExited("tab-42", { code: 0, reason: "clean" });
    expect(regionExited(currentSessionView()["tab-42"])).toBe(true);
  });

  it("setTerminalExited records exit info (code + reason) in the region (#1121)", () => {
    useAppStore.getState().setTerminalExited("tab-42", { code: 0, reason: "clean" });
    expect(currentSessionView()["tab-42"]?.exit).toEqual({ code: 0, reason: "clean" });
  });

  it("setTerminalExited records a non-zero exit code with a dropped reason (#1121)", () => {
    useAppStore.getState().setTerminalExited("tab-42", { code: 137, reason: "dropped" });
    expect(currentSessionView()["tab-42"]?.exit).toEqual({ code: 137, reason: "dropped" });
  });

  it("setTerminalExited with a killed reason enters view mode so no overlay is shown (#1121)", () => {
    useAppStore.getState().setTerminalExited("tab-42", { code: null, reason: "killed" });
    const state = useAppStore.getState();
    // Session is marked dead in the region...
    expect(regionExited(currentSessionView()["tab-42"])).toBe(true);
    // ...but view mode is set, so `isExited && !isViewMode` is false and the
    // "unexpected disconnect" overlay never appears.
    expect(state.terminalViewMode["tab-42"]).toBe(true);
    expect(currentSessionView()["tab-42"]?.exit).toEqual({ code: null, reason: "killed" });
  });

  it("setTerminalExited without info records nothing (no region fold) (#1121)", () => {
    useAppStore.getState().setTerminalExited("tab-42");
    // A bare exit dispatches no intent — the region stays untouched.
    expect(currentSessionView()["tab-42"]).toBeUndefined();
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

  it("setTerminalExited does not affect other tabs", () => {
    useAppStore.getState().setTerminalExited("tab-1", { code: 0, reason: "clean" });
    useAppStore.getState().setTerminalExited("tab-2", { code: 0, reason: "clean" });
    expect(regionExited(currentSessionView()["tab-1"])).toBe(true);
    expect(regionExited(currentSessionView()["tab-2"])).toBe(true);
  });

  it("setTerminalDisconnectWithError folds a failed status + error into the region", () => {
    useAppStore.getState().setTerminalDisconnectWithError("tab-42", "Connection refused");
    const life = currentSessionView()["tab-42"];
    expect(life?.status).toBe("failed");
    expect(life?.error).toBe("Connection refused");
    expect(regionExited(life)).toBe(true);
  });

  it("dismissTerminalDisconnect enters view mode without clearing the region exited state", () => {
    useAppStore.getState().setTerminalExited("tab-42", { code: null, reason: "dropped" });
    useAppStore.getState().dismissTerminalDisconnect("tab-42");
    const state = useAppStore.getState();
    expect(regionExited(currentSessionView()["tab-42"])).toBe(true);
    expect(state.terminalViewMode["tab-42"]).toBe(true);
  });

  it("dismissTerminalDisconnect does not increment retry counter", () => {
    useAppStore.getState().setTerminalExited("tab-42", { code: null, reason: "dropped" });
    useAppStore.getState().dismissTerminalDisconnect("tab-42");
    expect(useAppStore.getState().terminalRetryCounters["tab-42"]).toBeUndefined();
  });

  it("reconnectTerminal clears view mode and increments retry counter", () => {
    useAppStore.setState({
      terminalViewMode: { "tab-42": true },
      terminalReconnectPrompt: { "tab-42": true },
    });
    useAppStore.getState().reconnectTerminal("tab-42");

    const state = useAppStore.getState();
    expect(state.terminalViewMode["tab-42"]).toBeUndefined();
    expect(state.terminalReconnectPrompt["tab-42"]).toBeUndefined();
    expect(state.terminalRetryCounters["tab-42"]).toBe(1);
  });

  it("reconnectTerminal increments existing retry counter", () => {
    useAppStore.setState({
      terminalRetryCounters: { "tab-42": 3 },
    });
    useAppStore.getState().reconnectTerminal("tab-42");
    expect(useAppStore.getState().terminalRetryCounters["tab-42"]).toBe(4);
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
