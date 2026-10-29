/**
 * Tests for the Port Scanner result order (#5067).
 *
 * Results default to address order — numeric by host, then by port — kept
 * correct while they stream in, and can be switched to response order using
 * the same remembered preference as the Ping Sweep.
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
  networkPortScan: vi.fn(() => Promise.resolve("task-1")),
  networkPortScanCancel: vi.fn(() => Promise.resolve()),
  onScanResult: vi.fn(() => Promise.resolve(() => {})),
  onScanComplete: vi.fn(() => Promise.resolve(() => {})),
  onScanError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { onScanResult } from "@/services/networkApi";
import { PortScannerPanel } from "./PortScannerPanel";

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function start() {
  await act(async () => {
    root.render(<PortScannerPanel prefillHost="10.0.0.0/28" />);
  });
  await flush();
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="port-scanner-run"]')!.click();
  });
  await flush();
}

async function emit(host: string, port: number) {
  const cb = vi.mocked(onScanResult).mock.calls[0][0];
  await act(async () => {
    cb({ taskId: "task-1", host, port, state: "open" });
  });
  await flush();
}

function rowsShown(): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="port-scanner-result-"]')).map(
    (row) => {
      const cells = row.querySelectorAll("td");
      return `${cells[0]?.textContent}:${cells[1]?.textContent}`;
    }
  );
}

const ARRIVAL: [string, number][] = [
  ["10.0.0.10", 443],
  ["10.0.0.9", 22],
  ["10.0.0.100", 80],
  ["10.0.0.10", 22],
];

setupSettingsRegion();

describe("PortScannerPanel — result order (#5067)", () => {
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

  it("defaults to numeric host order, then port, while streaming", async () => {
    seedSettings({});
    await start();
    for (const [host, port] of ARRIVAL) await emit(host, port);

    expect(rowsShown()).toEqual(["10.0.0.9:22", "10.0.0.10:22", "10.0.0.10:443", "10.0.0.100:80"]);
  });

  it("shows response order when that is the remembered choice", async () => {
    seedSettings({ networkHostOrder: "response" });
    await start();
    for (const [host, port] of ARRIVAL) await emit(host, port);

    expect(rowsShown()).toEqual(["10.0.0.10:443", "10.0.0.9:22", "10.0.0.100:80", "10.0.0.10:22"]);
    expect(container.querySelector('[data-testid="port-scanner-order"]')).not.toBeNull();
  });
});
