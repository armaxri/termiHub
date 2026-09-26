import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalEvictedOverlay, TerminalWindowEvictedOverlay } from "./TerminalEvictedOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import { setSessionTransportForTest, stopSessionSubscription } from "@/store/sessionBridge";
import {
  connected,
  evicted,
  FakeSessionTransport,
  sessionLost,
} from "@/test/sessionLifecycleRegionTestHarness";

vi.mock("lucide-react", () => ({
  MonitorX: () => null,
  RefreshCw: () => null,
  Loader2: () => null,
  Check: () => null,
}));

const TAB = "tab-1";

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalEvictedOverlay (SM-003 single-attach)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let transport: FakeSessionTransport;
  const originalReclaim = useAppStore.getState().reclaimSession;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    transport = new FakeSessionTransport();
    setSessionTransportForTest(transport);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stopSessionSubscription();
    setSessionTransportForTest(null);
    useAppStore.setState({ reclaimSession: originalReclaim });
  });

  it("shows the taken-over notice with a Reclaim action when the tab is evicted", async () => {
    transport.setSession(TAB, evicted("This session was taken over by another desktop."));

    act(() => root.render(withTooltip(<TerminalEvictedOverlay tabId={TAB} />)));
    await flush();

    const overlay = container.querySelector("[data-testid='terminal-evicted-overlay']");
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("Taken over by another desktop");
    expect(container.querySelector("[data-testid='terminal-evicted-reclaim-btn']")).not.toBeNull();
  });

  it.each([
    ["connected", connected()],
    ["sessionLost", sessionLost("gone")],
  ])("renders nothing when the tab is %s", async (_label, life) => {
    transport.setSession(TAB, life);

    act(() => root.render(withTooltip(<TerminalEvictedOverlay tabId={TAB} />)));
    await flush();

    expect(container.querySelector("[data-testid='terminal-evicted-overlay']")).toBeNull();
  });

  it("Reclaim clears the stale screen first, then performs the explicit takeover", async () => {
    const calls: string[] = [];
    const reclaimSession = vi.fn(async (tabId: string) => {
      calls.push(`reclaim:${tabId}`);
      return true;
    });
    useAppStore.setState({ reclaimSession });
    const onBeforeReclaim = vi.fn(() => calls.push("clear"));
    transport.setSession(TAB, evicted());

    act(() =>
      root.render(
        withTooltip(<TerminalEvictedOverlay tabId={TAB} onBeforeReclaim={onBeforeReclaim} />)
      )
    );
    await flush();

    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='terminal-evicted-reclaim-btn']"
    );
    await act(async () => {
      btn?.click();
      await Promise.resolve();
    });

    expect(reclaimSession).toHaveBeenCalledTimes(1);
    expect(reclaimSession).toHaveBeenCalledWith(TAB);
    expect(calls).toEqual(["clear", `reclaim:${TAB}`]);
  });

  it("never reclaims on its own — only on the explicit user action", async () => {
    const reclaimSession = vi.fn(async () => true);
    useAppStore.setState({ reclaimSession });
    transport.setSession(TAB, evicted());

    act(() => root.render(withTooltip(<TerminalEvictedOverlay tabId={TAB} />)));
    await flush();

    expect(reclaimSession).not.toHaveBeenCalled();
  });
});

describe("TerminalWindowEvictedOverlay (#3368 window takeover)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const originalReclaim = useAppStore.getState().reclaimWindowSession;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState({ reclaimWindowSession: originalReclaim });
  });

  it("shows 'Taken over by another window' naming the controlling window", async () => {
    act(() =>
      root.render(
        withTooltip(
          <TerminalWindowEvictedOverlay sessionId="sess-1" controllingWindowName="Window 2" />
        )
      )
    );
    await flush();

    const overlay = container.querySelector("[data-testid='terminal-evicted-overlay']");
    expect(overlay?.getAttribute("data-evicted-by")).toBe("window");
    expect(overlay?.textContent).toContain("Taken over by another window");
    expect(overlay?.textContent).toContain("Window 2");
    expect(container.querySelector("[data-testid='terminal-evicted-reclaim-btn']")).not.toBeNull();
  });

  it("Reclaim claims the session for this window — only on the explicit click", async () => {
    const reclaimWindowSession = vi.fn(async () => true);
    useAppStore.setState({ reclaimWindowSession });

    act(() =>
      root.render(
        withTooltip(
          <TerminalWindowEvictedOverlay sessionId="sess-1" controllingWindowName="Window 2" />
        )
      )
    );
    await flush();
    expect(reclaimWindowSession).not.toHaveBeenCalled();

    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='terminal-evicted-reclaim-btn']"
    );
    await act(async () => {
      btn?.click();
      await Promise.resolve();
    });

    expect(reclaimWindowSession).toHaveBeenCalledTimes(1);
    expect(reclaimWindowSession).toHaveBeenCalledWith("sess-1");
  });
});
