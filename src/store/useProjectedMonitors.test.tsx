/**
 * `useProjectedMonitors` — the status bar & Open Connections read the now
 * **authoritative** `system-monitors` region (#2224). Drives the hook against an
 * in-memory substrate double and asserts: it returns the region view, updates on
 * region diffs, and reflects client-dispatched intents that fold into the region.
 * There is no `appStore` fallback and no mirror gate — the region is the source of
 * truth.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dispatchMonitorIntent,
  ensureMonitorsSubscribed,
  setMonitorTransportForTest,
  stopMonitorsSubscription,
  type SystemMonitorsView,
} from "./systemMonitorBridge";
import { useProjectedMonitors } from "./useProjectedMonitors";
import {
  FakeMonitorTransport,
  fakeMonitor,
  fakeStats,
  monitorsView,
} from "@/test/systemMonitorHarness";

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => SystemMonitorsView; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: SystemMonitorsView = { monitors: {}, statsCache: {} };

  function Probe() {
    latest = useProjectedMonitors();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeMonitorTransport;

beforeEach(() => {
  transport = new FakeMonitorTransport();
  setMonitorTransportForTest(transport);
});

afterEach(() => {
  stopMonitorsSubscription();
  setMonitorTransportForTest(null);
});

/**
 * Wait (inside `act`) until the shared region subscription has adopted its
 * snapshot and the hook's post-subscribe `setView` has committed. Deterministic:
 * it awaits the actual subscription promise rather than counting microtask hops.
 */
const subscribed = () =>
  act(async () => {
    await ensureMonitorsSubscribed();
  });

describe("useProjectedMonitors", () => {
  it("renders the region view once subscribed", async () => {
    const view = monitorsView([fakeMonitor("s1", { stats: fakeStats("host-a", 21) })], {
      s1: fakeStats("host-a", 21),
    });
    transport.seed(view);

    const hook = renderHook();
    await subscribed();

    expect(hook.get().monitors.s1.stats?.cpuUsagePercent).toBe(21);
    expect(hook.get()).toEqual(view);
    hook.unmount();
  });

  it("updates when the region advances after mount", async () => {
    const hook = renderHook();
    await subscribed();
    expect(hook.get().monitors.s1).toBeUndefined();

    // The region diff fans out to the hook's listener synchronously, so the
    // resulting `setView` must happen inside `act` for React to commit it before
    // the assertion. Outside `act` it lands on React's scheduler (a macrotask)
    // and a loaded runner could assert before it ran (#3868).
    act(() => transport.seed(monitorsView([fakeMonitor("s2", { host: "host-b" })])));

    expect(hook.get().monitors.s2?.host).toBe("host-b");
    hook.unmount();
  });

  it("reflects a client-dispatched intent that folds into the region", async () => {
    transport.seed(monitorsView([fakeMonitor("s1", { paused: false })]));
    const hook = renderHook();
    await subscribed();
    expect(hook.get().monitors.s1.paused).toBe(false);

    await act(async () => {
      await dispatchMonitorIntent("monitor.setPaused", { key: "s1", paused: true });
    });

    expect(hook.get().monitors.s1.paused).toBe(true);
    hook.unmount();
  });
});
