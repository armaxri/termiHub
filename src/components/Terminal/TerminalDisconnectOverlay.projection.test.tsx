import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import {
  SESSION_LIFECYCLE_REGION,
  setSessionIntentsEnabled,
  setSessionRenderFromProjectionEnabled,
  setSessionTransportForTest,
  stopSessionSubscription,
  type ProjectedSessionLifecycle,
} from "@/store/sessionBridge";
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

/**
 * An in-memory `session-lifecycle` region double: holds one view and fans a fresh
 * snapshot to every subscriber on each mutation, so the overlay's render can be
 * driven by projected snapshots without a backend (#2204, reusing the #2164
 * harness idea from `sessionBridge.test.ts`).
 */
class FakeTransport implements Transport {
  private view: { sessions: Record<string, ProjectedSessionLifecycle> } = { sessions: {} };
  private version = 0;
  private handlers: FrameHandler[] = [];
  subscribeCount = 0;

  async dispatch(intent: Intent): Promise<IntentAck> {
    return { intentId: intent.intentId, status: "accepted", produced: [] };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.subscribeCount += 1;
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  /** Set a session's projected lifecycle and fan the snapshot out. */
  setSession(id: string, life: ProjectedSessionLifecycle): void {
    this.view.sessions[id] = life;
    this.version += 1;
    this.fan();
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(SESSION_LIFECYCLE_REGION);
    for (const h of this.handlers) h(frame);
  }
}

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

function reconnecting(
  reconnect: ProjectedSessionLifecycle["reconnect"]
): ProjectedSessionLifecycle {
  return { status: "reconnecting", reconnect };
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
  let transport: FakeTransport;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    transport = new FakeTransport();
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
