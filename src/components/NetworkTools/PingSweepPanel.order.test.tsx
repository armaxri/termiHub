/**
 * Tests for the Ping Sweep result order (#5067).
 *
 * Responders arrive in whatever order they answer. The table defaults to
 * numeric address order (kept correct while results stream in), can be switched
 * to response order, and remembers the choice in the persisted settings.
 */
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/storage", async () => {
  const actual = await vi.importActual<typeof import("@/services/storage")>("@/services/storage");
  return { ...actual, saveSettings: vi.fn(() => Promise.resolve()) };
});

vi.mock("@/services/networkApi", () => ({
  networkPingSweep: vi.fn(() => Promise.resolve("task-1")),
  networkPingSweepCancel: vi.fn(() => Promise.resolve()),
  onSweepResult: vi.fn(() => Promise.resolve(() => {})),
  onSweepComplete: vi.fn(() => Promise.resolve(() => {})),
  onSweepError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const historyApi = vi.hoisted(() => ({
  listNetworkToolRuns: vi.fn(() => Promise.resolve([])),
  recordNetworkToolRun: vi.fn((run: unknown) => Promise.resolve(run)),
  deleteNetworkToolRun: vi.fn(),
  clearNetworkToolHistory: vi.fn(),
}));
vi.mock("@/services/networkHistoryApi", () => historyApi);

import { onSweepComplete, onSweepResult } from "@/services/networkApi";
import type { NetworkToolRun } from "@/types/network";
import { currentSettingsView } from "@/store/settingsBridge";
import { PingSweepPanel } from "./PingSweepPanel";

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderPanel() {
  await act(async () => {
    root.render(<PingSweepPanel prefillHost="192.168.0.0/24" />);
  });
  await flush();
}

async function clickRun() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="ping-sweep-run"]')!.click();
  });
  await flush();
}

async function emit(host: string) {
  const cb = vi.mocked(onSweepResult).mock.calls[0][0];
  await act(async () => {
    cb({ taskId: "task-1", host, latencyMs: 1, hostname: null });
  });
  await flush();
}

function hostsShown(): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="ping-sweep-result-"]')).map(
    (row) => row.querySelector("td")?.textContent ?? ""
  );
}

async function chooseOrder(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="ping-sweep-order"]')!;
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
    o.textContent?.includes(label)
  ) as HTMLElement | undefined;
  expect(option).toBeTruthy();
  await act(async () => {
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

const ARRIVAL = [
  "192.168.0.1",
  "192.168.0.90",
  "192.168.0.102",
  "192.168.0.91",
  "192.168.0.253",
  "192.168.0.254",
  "192.168.0.239",
];

setupSettingsRegion();

describe("PingSweepPanel — result order (#5067)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("defaults to numeric address order and stays sorted while streaming", async () => {
    seedSettings({});
    await renderPanel();
    await clickRun();

    await emit("192.168.0.1");
    await emit("192.168.0.90");
    await emit("192.168.0.102");
    await emit("192.168.0.91");
    expect(hostsShown()).toEqual(["192.168.0.1", "192.168.0.90", "192.168.0.91", "192.168.0.102"]);

    for (const host of ARRIVAL.slice(4)) await emit(host);
    expect(hostsShown()).toEqual([
      "192.168.0.1",
      "192.168.0.90",
      "192.168.0.91",
      "192.168.0.102",
      "192.168.0.239",
      "192.168.0.253",
      "192.168.0.254",
    ]);
  });

  it("switches to response order and remembers the choice", async () => {
    seedSettings({});
    await renderPanel();
    await clickRun();
    for (const host of ARRIVAL) await emit(host);

    await chooseOrder("Response");
    expect(hostsShown()).toEqual(ARRIVAL);
    expect(currentSettingsView().networkHostOrder).toBe("response");

    await chooseOrder("Address");
    expect(hostsShown()[3]).toBe("192.168.0.102");
    expect(currentSettingsView().networkHostOrder).toBe("address");
  });

  it("honours a remembered response order", async () => {
    seedSettings({ networkHostOrder: "response" });
    await renderPanel();
    await clickRun();
    for (const host of ARRIVAL) await emit(host);

    expect(hostsShown()).toEqual(ARRIVAL);
  });

  it("records the run's history table in address order", async () => {
    seedSettings({ networkHostOrder: "response" });
    await renderPanel();
    await clickRun();
    for (const host of ARRIVAL) await emit(host);
    const done = vi.mocked(onSweepComplete).mock.calls[0][0];
    await act(async () => {
      done({
        taskId: "task-1",
        summary: { total: 254, up: ARRIVAL.length, down: 247, elapsedMs: 900 },
        canceled: false,
      });
    });
    await flush();

    const calls = historyApi.recordNetworkToolRun.mock.calls;
    const run = calls[calls.length - 1][0] as NetworkToolRun;
    expect(run.result?.rows.map((r) => r[0])).toEqual([
      "192.168.0.1",
      "192.168.0.90",
      "192.168.0.91",
      "192.168.0.102",
      "192.168.0.239",
      "192.168.0.253",
      "192.168.0.254",
    ]);
  });
});
