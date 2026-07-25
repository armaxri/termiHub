/**
 * Tests for the Ping Sweep panel (#1936).
 *
 * Covers the core behaviour: a small range starts immediately, responding hosts
 * stream into the live table (with RTT + reverse-DNS name), the running footer
 * surfaces the up-count, the completion footer reports up/down, and Stop cancels
 * the in-flight sweep.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  networkPingSweep,
  networkPingSweepCancel,
  onSweepResult,
  onSweepComplete,
} from "@/services/networkApi";
import { PingSweepPanel } from "./PingSweepPanel";

vi.mock("@/services/networkApi", () => ({
  networkPingSweep: vi.fn(() => Promise.resolve("task-1")),
  networkPingSweepCancel: vi.fn(() => Promise.resolve()),
  onSweepResult: vi.fn(() => Promise.resolve(() => {})),
  onSweepComplete: vi.fn(() => Promise.resolve(() => {})),
  onSweepError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderPanel(prefillHost: string) {
  await act(async () => {
    root.render(<PingSweepPanel prefillHost={prefillHost} />);
  });
  await flush();
}

async function clickRun() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="ping-sweep-run"]')!.click();
  });
  await flush();
}

async function emitResult(host: string, latencyMs?: number, hostname?: string) {
  const cb = vi.mocked(onSweepResult).mock.calls[0][0];
  await act(async () => {
    cb({ taskId: "task-1", host, latencyMs, hostname });
  });
  await flush();
}

async function emitComplete(up: number, down: number) {
  const cb = vi.mocked(onSweepComplete).mock.calls[0][0];
  await act(async () => {
    cb({
      taskId: "task-1",
      summary: { total: up + down, up, down, elapsedMs: 1500 },
      canceled: false,
    });
  });
  await flush();
}

function footerText(): string {
  return container.querySelector('[data-testid="ping-sweep-footer"]')?.textContent ?? "";
}

describe("PingSweepPanel", () => {
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

  it("starts a small sweep immediately (no warning)", async () => {
    await renderPanel("192.168.1.0/30");
    await clickRun();

    expect(document.body.querySelector('[data-testid="ping-sweep-warn-modal"]')).toBeNull();
    expect(networkPingSweep).toHaveBeenCalledTimes(1);
  });

  it("streams responding hosts into the live table with RTT and name", async () => {
    await renderPanel("192.168.1.0/30");
    await clickRun();

    await emitResult("192.168.1.1", 4, "router.local");
    await emitResult("192.168.1.2", 12);

    const rows = container.querySelectorAll('[data-testid^="ping-sweep-result-"]');
    expect(rows.length).toBe(2);
    const firstRow = rows[0].textContent ?? "";
    expect(firstRow).toContain("192.168.1.1");
    expect(firstRow).toContain("4ms");
    expect(firstRow).toContain("router.local");
    // Second host has no reverse-DNS name → placeholder dash.
    expect(rows[1].textContent).toContain("12ms");

    // Running footer surfaces the live up-count.
    expect(footerText()).toContain("2 up so far");
  });

  it("reports up/down counts in the footer on completion", async () => {
    await renderPanel("192.168.1.0/24");
    await clickRun();

    await emitResult("192.168.1.5", 3);
    await emitComplete(1, 253);

    const text = footerText();
    expect(text).toContain("1 up");
    expect(text).toContain("253 down");
  });

  it("cancels the sweep when Stop is pressed", async () => {
    await renderPanel("192.168.1.0/30");
    await clickRun();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="ping-sweep-stop"]')!.click();
    });
    await flush();

    expect(networkPingSweepCancel).toHaveBeenCalledWith("task-1");
  });
});
