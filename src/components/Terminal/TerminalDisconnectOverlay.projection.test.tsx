import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import {
  setSessionIntentsEnabled,
  setSessionRenderFromProjectionEnabled,
  setSessionTransportForTest,
  stopSessionSubscription,
} from "@/store/sessionBridge";
import {
  failed,
  FakeSessionTransport,
  reconnecting,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { TerminalAutoReconnectState } from "@/types/terminal";

// Stub lucide-react icons used in the overlay.
vi.mock("lucide-react", () => ({
  WifiOff: () => null,
  RefreshCw: () => null,
  X: () => null,
  AlertTriangle: () => null,
  Loader2: () => null,
  CheckCircle2: () => null,
}));

const TAB = "tab-1";

function record(over: Partial<TerminalAutoReconnectState> = {}): TerminalAutoReconnectState {
  return {
    phase: "waiting",
    attempt: 1,
    maxAttempts: 10,
    delayMs: 3_000,
    nextAttemptAt: Date.now() + 3_000,
    ...over,
  };
}

/** Flush the bridge's async subscribe + fan-out so the projected snapshot lands. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalDisconnectOverlay — projected session-lifecycle render cut (#2204)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let transport: FakeSessionTransport;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    transport = new FakeSessionTransport();
    setSessionTransportForTest(transport);
    setSessionRenderFromProjectionEnabled(true);
    setSessionIntentsEnabled(true);
    useAppStore.setState({
      terminalExitedTabs: { [TAB]: true },
      terminalDisconnectErrors: {},
      terminalViewMode: {},
      terminalReconnectingTabs: {},
      terminalReconnectTriggerErrors: {},
      terminalAutoReconnect: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stopSessionSubscription();
    setSessionTransportForTest(null);
    setSessionRenderFromProjectionEnabled(null);
    setSessionIntentsEnabled(null);
  });

  it("renders the countdown from a mirroring projected snapshot", async () => {
    useAppStore.setState({ terminalAutoReconnect: { [TAB]: record({ attempt: 1 }) } });
    transport.setSession(TAB, reconnecting({ phase: "waiting", attempt: 1, delayMs: 3_000 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    // The region was actually subscribed and drove the render.
    expect(transport.subscribeCount).toBeGreaterThan(0);
    const countdown = container.querySelector("[data-testid='terminal-auto-reconnect-countdown']");
    expect(countdown).not.toBeNull();
    expect(countdown?.textContent).toContain("Attempt 2 of 10");
  });

  it("keeps the countdown identical to appStore when the projection diverges (mirror-fallback parity)", async () => {
    // Local record is attempt 1 ("Attempt 2"); the projected snapshot is stale at
    // a wildly different attempt. The faithful-mirror gate must reject it and the
    // overlay must stay byte-identical to the local record.
    useAppStore.setState({ terminalAutoReconnect: { [TAB]: record({ attempt: 1 }) } });
    transport.setSession(TAB, reconnecting({ phase: "waiting", attempt: 7, delayMs: 99_000 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const countdown = container.querySelector("[data-testid='terminal-auto-reconnect-countdown']");
    expect(countdown?.textContent).toContain("Attempt 2 of 10");
    expect(countdown?.textContent).not.toContain("Attempt 8");
  });

  it("falls back to appStore verbatim when the render cut is off", async () => {
    setSessionRenderFromProjectionEnabled(false);
    useAppStore.setState({ terminalAutoReconnect: { [TAB]: record({ attempt: 3 }) } });
    // A divergent snapshot exists but must be ignored with the flag off.
    transport.setSession(TAB, reconnecting({ phase: "waiting", attempt: 0, delayMs: 1_000 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const countdown = container.querySelector("[data-testid='terminal-auto-reconnect-countdown']");
    expect(countdown?.textContent).toContain("Attempt 4 of 10");
    // With the cut off the hook never subscribes to the region.
    expect(transport.subscribeCount).toBe(0);
  });

  it("renders the reconnecting spinner sourced from a mirroring projected snapshot", async () => {
    useAppStore.setState({ terminalReconnectingTabs: { [TAB]: true } });
    transport.setSession(TAB, reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    expect(transport.subscribeCount).toBeGreaterThan(0);
    // The reconnecting variant shows its Stop affordance (no countdown variant).
    const overlay = container.querySelector("[data-testid='terminal-disconnect-overlay']");
    expect(overlay?.textContent).toContain("Reconnecting");
  });

  it("renders the disconnect error sourced from a mirroring failed snapshot", async () => {
    useAppStore.setState({ terminalDisconnectErrors: { [TAB]: "auth failed" } });
    transport.setSession(TAB, failed("auth failed"));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const overlay = container.querySelector("[data-testid='terminal-disconnect-overlay']");
    expect(overlay?.textContent).toContain("auth failed");
  });

  it("shows no auto-reconnect overlay when there is no local loop, whatever the region says", async () => {
    // The region reports a reconnecting session, but appStore has no loop record:
    // the overlay is seeded from appStore, so nothing spurious renders.
    transport.setSession(TAB, reconnecting({ phase: "waiting", attempt: 2, delayMs: 5_000 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    // The exited (non-view-mode) disconnect overlay shows, but not the reconnect
    // countdown variant.
    expect(container.querySelector("[data-testid='terminal-auto-reconnect-countdown']")).toBeNull();
  });
});
