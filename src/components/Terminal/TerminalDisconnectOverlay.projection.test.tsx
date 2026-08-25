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
  idleReconnect,
  reconnecting,
} from "@/test/sessionLifecycleRegionTestHarness";

// Stub lucide-react icons used in the overlay.
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

const TAB = "tab-1";

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
    transport.setSession(TAB, reconnecting({ phase: "waiting", attempt: 1, delayMs: 3_000 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    // The region was actually subscribed and drove the render.
    expect(transport.subscribeCount).toBeGreaterThan(0);
    const countdown = container.querySelector("[data-testid='terminal-auto-reconnect-countdown']");
    expect(countdown).not.toBeNull();
    expect(countdown?.textContent).toContain("Attempt 2 of 10");
  });

  it("sources the countdown numbers purely from the region, ignoring any stale appStore record", async () => {
    // The region is the sole source of the reconnect loop (#2205 PR-B): a local
    // `appStore` record at a different attempt does NOT override it — the overlay
    // renders the region's attempt (7 ⇒ "Attempt 8 of 10"), not the local one.
    transport.setSession(TAB, reconnecting({ phase: "waiting", attempt: 7, delayMs: 99_000 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const countdown = container.querySelector("[data-testid='terminal-auto-reconnect-countdown']");
    expect(countdown?.textContent).toContain("Attempt 8 of 10");
    expect(countdown?.textContent).not.toContain("Attempt 2 of 10");
  });

  it("keeps sourcing the countdown from the region regardless of the render flag", async () => {
    // The reconnect loop moved off `appStore` entirely (#2205 PR-B), so the
    // render-cut flag no longer gates it — the region drives the countdown even
    // with the flag off, and the hook still subscribes to source it.
    setSessionRenderFromProjectionEnabled(false);
    transport.setSession(TAB, reconnecting({ phase: "waiting", attempt: 3, delayMs: 1_000 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const countdown = container.querySelector("[data-testid='terminal-auto-reconnect-countdown']");
    expect(countdown?.textContent).toContain("Attempt 4 of 10");
    // The region is the sole source, so the hook subscribes regardless of the flag.
    expect(transport.subscribeCount).toBeGreaterThan(0);
  });

  it("renders the reconnecting spinner sourced from a mirroring projected snapshot", async () => {
    transport.setSession(TAB, reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    expect(transport.subscribeCount).toBeGreaterThan(0);
    // The reconnecting variant shows its Stop affordance (no countdown variant).
    const overlay = container.querySelector("[data-testid='terminal-disconnect-overlay']");
    expect(overlay?.textContent).toContain("Reconnecting");
  });

  it("renders the reconnecting overlay for a transient agent-break shape: status reconnecting, loop idle (#2555)", async () => {
    // Regression for the #2554 gap: a transient agent-transport break folds the
    // region to `reconnecting` with the loop **idle** (no backoff — the agent I/O
    // task recovers in place). The overlay reads reconnecting purely from the
    // region, so it must render for this exact shape; before #2555 the region was
    // never folded for a transient break and the overlay stayed hidden.
    transport.setSession(TAB, reconnecting(idleReconnect(), "connection reset"));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    expect(transport.subscribeCount).toBeGreaterThan(0);
    const overlay = container.querySelector("[data-testid='terminal-disconnect-overlay']");
    expect(overlay?.textContent).toContain("Reconnecting");
    // The trigger cause is surfaced, and no countdown variant is shown (idle loop).
    expect(overlay?.textContent).toContain("connection reset");
    expect(container.querySelector("[data-testid='terminal-auto-reconnect-countdown']")).toBeNull();
  });

  it("renders the reconnect-trigger error sourced from a mirroring region snapshot (#2442)", async () => {
    transport.setSession(
      TAB,
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 }, "connection reset")
    );

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    expect(transport.subscribeCount).toBeGreaterThan(0);
    const errorBox = container.querySelector(
      "[data-testid='terminal-disconnect-trigger-error-box']"
    );
    expect(errorBox?.textContent).toContain("connection reset");
  });

  it("sources the trigger error purely from the region, ignoring any stale appStore value (#2442)", async () => {
    // The reconnect-trigger cause is region-owned since #2205 PR-B: a divergent
    // local `appStore` value does not override it — the overlay shows the region's
    // cause, not the local one.
    transport.setSession(
      TAB,
      reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 }, "region cause")
    );

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const errorBox = container.querySelector(
      "[data-testid='terminal-disconnect-trigger-error-box']"
    );
    expect(errorBox?.textContent).toContain("region cause");
    expect(errorBox?.textContent).not.toContain("local cause");
  });

  it("renders the disconnect error sourced from a mirroring failed snapshot", async () => {
    useAppStore.setState({ terminalDisconnectErrors: { [TAB]: "auth failed" } });
    transport.setSession(TAB, failed("auth failed"));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const overlay = container.querySelector("[data-testid='terminal-disconnect-overlay']");
    expect(overlay?.textContent).toContain("auth failed");
  });

  it("renders the auto-reconnect countdown from the region even with no local appStore loop record", async () => {
    // The region is the sole source of the reconnect loop (#2205 PR-B): a waiting
    // reconnect drives the countdown variant on its own, without any
    // `appStore.terminalAutoReconnect` record seeding it.
    transport.setSession(TAB, reconnecting({ phase: "waiting", attempt: 2, delayMs: 5_000 }));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const countdown = container.querySelector("[data-testid='terminal-auto-reconnect-countdown']");
    expect(countdown).not.toBeNull();
    expect(countdown?.textContent).toContain("Attempt 3 of 10");
  });
});
