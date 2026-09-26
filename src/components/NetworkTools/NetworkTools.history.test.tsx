/**
 * Panel ↔ run-history wiring (PROD-032): finished runs are recorded with their
 * params, status and run location (local and agent), and a history Re-run
 * restores the recorded params and starts the tool with them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { NetworkToolRun } from "@/types/network";

const net = vi.hoisted(() => ({
  networkPingStart: vi.fn(() => Promise.resolve("task-1")),
  networkPingStop: vi.fn(() => Promise.resolve()),
  onPingResult: vi.fn(() => Promise.resolve(() => {})),
  onPingComplete: vi.fn(() => Promise.resolve(() => {})),
  onPingError: vi.fn(() => Promise.resolve(() => {})),
  networkDnsLookup: vi.fn(),
  networkWolSend: vi.fn(() => Promise.resolve()),
  networkWolDevicesList: vi.fn(() => Promise.resolve([])),
  networkWolDeviceSave: vi.fn(),
  networkWolDeviceDelete: vi.fn(),
}));
vi.mock("@/services/networkApi", () => net);

const historyApi = vi.hoisted(() => ({
  listNetworkToolRuns: vi.fn(() => Promise.resolve([])),
  recordNetworkToolRun: vi.fn((run: unknown) => Promise.resolve(run)),
  deleteNetworkToolRun: vi.fn(),
  clearNetworkToolHistory: vi.fn(),
}));
vi.mock("@/services/networkHistoryApi", () => historyApi);
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

import { useNetworkToolHistoryStore } from "@/store/networkToolHistoryStore";
import { useRunLocationStore } from "@/store/runLocationStore";
import { PingPanel } from "./PingPanel";
import { DnsLookupPanel } from "./DnsLookupPanel";
import { WolPanel } from "./WolPanel";

let container: HTMLDivElement;
let root: Root;

function q(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function recorded(): NetworkToolRun[] {
  return historyApi.recordNetworkToolRun.mock.calls.map((c) => c[0] as NetworkToolRun);
}

type CompleteCb = (p: { taskId: string; stats: unknown; canceled: boolean }) => void;

async function completePing(canceled = false) {
  const calls = net.onPingComplete.mock.calls as unknown as [CompleteCb][];
  const cb = calls[calls.length - 1][0];
  await act(async () => {
    cb({
      taskId: "task-1",
      stats: {
        sent: 4,
        received: 3,
        lossPercent: 25,
        minMs: 1,
        avgMs: 12,
        maxMs: 20,
        jitterMs: 2,
      },
      canceled,
    });
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  useNetworkToolHistoryStore.setState({ runs: [], loaded: false });
  useRunLocationStore.setState({ networkToolLocations: {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PingPanel run history", () => {
  it("records a completed local run with its params and closing stats", async () => {
    await act(async () => root.render(<PingPanel prefillHost="example.com" />));
    await act(async () => q("ping-start")!.click());
    await flush();
    await completePing();

    const runs = recorded();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      tool: "ping",
      status: "completed",
      params: { host: "example.com", intervalMs: 1000, count: null },
      runLocation: { kind: "thisComputer" },
      summary: "3/4 received, 25.0% loss, avg 12ms",
    });
    expect(runs[0].result!.columns[0]).toBe("seq");
  });

  it("records the agent it ran on and a canceled status", async () => {
    useRunLocationStore.getState().setNetworkToolLocation("ping", {
      kind: "agent",
      agentId: "agent-9",
    });
    await act(async () => root.render(<PingPanel prefillHost="10.0.0.1" />));
    await act(async () => q("ping-start")!.click());
    await flush();
    await completePing(true);

    expect(recorded()[0]).toMatchObject({
      status: "canceled",
      runLocation: { kind: "agent", agentId: "agent-9" },
    });
  });

  it("re-runs a past run with its recorded params", async () => {
    const past: NetworkToolRun = {
      id: "old",
      tool: "ping",
      params: { host: "rerun.example", intervalMs: 250, count: 7 },
      runLocation: { kind: "thisComputer" },
      startedAt: "2026-09-26T10:00:00Z",
      endedAt: "2026-09-26T10:00:02Z",
      status: "completed",
      summary: "old run",
    };
    historyApi.listNetworkToolRuns.mockResolvedValue([past] as never);
    await act(async () => root.render(<PingPanel />));
    await flush();
    await act(async () => q("network-history-toggle")!.click());
    await act(async () => q("network-history-rerun")!.click());
    await flush();

    expect(net.networkPingStart).toHaveBeenCalledWith("rerun.example", 250, 7);
    expect((q("ping-host") as HTMLInputElement).value).toBe("rerun.example");
  });
});

describe("DnsLookupPanel run history", () => {
  it("records a successful lookup with its records", async () => {
    net.networkDnsLookup.mockResolvedValue({
      records: [{ recordType: "A", name: "example.com", value: "1.2.3.4", ttl: 60 }],
      queryMs: 5,
    });
    await act(async () => root.render(<DnsLookupPanel prefillHost="example.com" />));
    await act(async () => q("dns-run")!.click());
    await flush();

    expect(recorded()[0]).toMatchObject({
      tool: "dns-lookup",
      status: "completed",
      params: { hostname: "example.com", recordType: "A", server: "" },
      summary: "1 A record(s) in 5ms",
      result: { rows: [["A", "example.com", "1.2.3.4", 60]], totalRows: 1 },
    });
  });

  it("records a failed lookup with its error", async () => {
    net.networkDnsLookup.mockRejectedValue(new Error("NXDOMAIN"));
    await act(async () => root.render(<DnsLookupPanel prefillHost="nope.example" />));
    await act(async () => q("dns-run")!.click());
    await flush();

    expect(recorded()[0]).toMatchObject({ status: "error", error: "Error: NXDOMAIN" });
  });
});

describe("WolPanel run history", () => {
  it("records each magic-packet send", async () => {
    await act(async () => root.render(<WolPanel />));
    const mac = q("wol-mac") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(mac, "AA:BB:CC:DD:EE:FF");
      mac.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => q("wol-send")!.click());
    await flush();

    expect(recorded()[0]).toMatchObject({
      tool: "wol",
      status: "completed",
      params: { mac: "AA:BB:CC:DD:EE:FF", broadcast: "255.255.255.255", port: 9 },
    });
  });
});
