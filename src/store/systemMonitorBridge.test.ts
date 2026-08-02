import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  currentMonitorsView,
  dispatchMonitorIntent,
  dispatchMonitorIntentBestEffort,
  ensureMonitorsSubscribed,
  onMonitorsView,
  setMonitorTransportForTest,
  stopMonitorsSubscription,
  type SystemMonitorsView,
} from "./systemMonitorBridge";
import {
  FakeMonitorTransport,
  fakeMonitor,
  fakeStats,
  monitorsView,
} from "@/test/systemMonitorHarness";
import { flushMacrotask } from "@/test/flushAsync";

let transport: FakeMonitorTransport;

beforeEach(() => {
  transport = new FakeMonitorTransport();
  setMonitorTransportForTest(transport);
});

afterEach(() => {
  stopMonitorsSubscription();
  setMonitorTransportForTest(null);
});

describe("region subscription + fan-out", () => {
  it("fans the projected view out to every listener and caches the latest", async () => {
    const a: SystemMonitorsView[] = [];
    const b: SystemMonitorsView[] = [];
    const unA = onMonitorsView((v) => a.push(v));
    const unB = onMonitorsView((v) => b.push(v));
    await ensureMonitorsSubscribed();

    const view = monitorsView([fakeMonitor("s1", { stats: fakeStats("host-a", 21) })], {
      s1: fakeStats("host-a", 21),
    });
    transport.seed(view);

    expect(a[a.length - 1]).toEqual(view);
    expect(b[b.length - 1]).toEqual(view);
    expect(currentMonitorsView()).toEqual(view);
    unA();
    unB();
  });

  it("stops delivering once unsubscribed", async () => {
    const received: SystemMonitorsView[] = [];
    const unsubscribe = onMonitorsView((v) => received.push(v));
    await ensureMonitorsSubscribed();
    unsubscribe();
    const before = received.length;

    transport.seed(monitorsView([fakeMonitor("s1")]));
    expect(received.length).toBe(before);
  });
});

describe("dispatchMonitorIntent (client-originated, authoritative round-trip)", () => {
  it("folds a client intent back into the projected view", async () => {
    await ensureMonitorsSubscribed();
    transport.seed(monitorsView([fakeMonitor("s1", { paused: false })]));

    const ack = await dispatchMonitorIntent("monitor.setPaused", { key: "s1", paused: true });

    expect(ack.status).toBe("accepted");
    expect(currentMonitorsView().monitors.s1.paused).toBe(true);
    expect(currentMonitorsView().monitors.s1.status).toBe("paused");
  });

  it("drops the entry on monitor.close but retains the stats cache", async () => {
    await ensureMonitorsSubscribed();
    transport.seed(
      monitorsView([fakeMonitor("s1", { stats: fakeStats("host-a") })], { s1: fakeStats("host-a") })
    );

    await dispatchMonitorIntent("monitor.close", { key: "s1" });

    expect(currentMonitorsView().monitors.s1).toBeUndefined();
    expect(currentMonitorsView().statsCache.s1).toBeDefined();
  });

  it("clears an error on monitor.clearError", async () => {
    await ensureMonitorsSubscribed();
    transport.seed(monitorsView([fakeMonitor("s1", { error: "boom", monitorSessionId: null })]));

    await dispatchMonitorIntent("monitor.clearError", { key: "s1" });

    expect(currentMonitorsView().monitors.s1.error).toBeNull();
  });
});

describe("dispatchMonitorIntentBestEffort", () => {
  it("dispatches the intent without throwing", async () => {
    await ensureMonitorsSubscribed();
    transport.seed(monitorsView([fakeMonitor("s1", { monitorSessionId: null })]));

    dispatchMonitorIntentBestEffort("monitor.close", { key: "s1" });
    await flushMacrotask();

    expect(transport.kinds()).toContain("monitor.close");
    expect(currentMonitorsView().monitors.s1).toBeUndefined();
  });

  it("swallows a transport that rejects", async () => {
    const throwing = {
      dispatch: () => Promise.reject(new Error("no socket")),
      subscribe: async () => ({ snapshot: undefined, unsubscribe: () => {} }),
      resync: async () => null,
    } as unknown as Parameters<typeof setMonitorTransportForTest>[0];
    setMonitorTransportForTest(throwing);

    expect(() =>
      dispatchMonitorIntentBestEffort("monitor.clearError", { key: "s1" })
    ).not.toThrow();
    await flushMacrotask();
  });
});
