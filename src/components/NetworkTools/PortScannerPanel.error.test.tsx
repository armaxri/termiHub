/**
 * Regression tests for PortScannerPanel error handling and the
 * listeners-before-start ordering (same race that hung the Ping panel).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkPortScan, onScanResult, onScanComplete, onScanError } from "@/services/networkApi";
import { PortScannerPanel } from "./PortScannerPanel";

vi.mock("@/services/networkApi", () => ({
  networkPortScan: vi.fn(() => Promise.resolve("task-1")),
  networkPortScanCancel: vi.fn(() => Promise.resolve()),
  onScanResult: vi.fn(() => Promise.resolve(() => {})),
  onScanComplete: vi.fn(() => Promise.resolve(() => {})),
  onScanError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function start() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="port-scanner-run"]')!.click();
  });
  await flush();
}

describe("PortScannerPanel — error handling", () => {
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

  it("registers all listeners before starting (no event race)", async () => {
    await act(async () => {
      root.render(<PortScannerPanel prefillHost="does-not-exist.invalid" />);
    });
    await start();

    const startOrder = vi.mocked(networkPortScan).mock.invocationCallOrder[0];
    expect(vi.mocked(onScanResult).mock.invocationCallOrder[0]).toBeLessThan(startOrder);
    expect(vi.mocked(onScanComplete).mock.invocationCallOrder[0]).toBeLessThan(startOrder);
    expect(vi.mocked(onScanError).mock.invocationCallOrder[0]).toBeLessThan(startOrder);
  });

  it("leaves the running state and shows the error when the target fails", async () => {
    await act(async () => {
      root.render(<PortScannerPanel prefillHost="does-not-exist.invalid" />);
    });
    await start();

    expect(container.querySelector('[data-testid="port-scanner-run"]')).toBeNull();

    const errorCb = vi.mocked(onScanError).mock.calls[0][0];
    await act(async () => {
      errorCb({ taskId: "task-1", error: "invalid target" });
    });
    await flush();

    expect(container.querySelector('[data-testid="port-scanner-run"]')).not.toBeNull();
    expect(container.textContent).toContain("invalid target");
  });

  it("ignores errors for a different task id", async () => {
    await act(async () => {
      root.render(<PortScannerPanel prefillHost="host" />);
    });
    await start();

    const errorCb = vi.mocked(onScanError).mock.calls[0][0];
    await act(async () => {
      errorCb({ taskId: "other", error: "unrelated" });
    });
    await flush();

    expect(container.querySelector('[data-testid="port-scanner-run"]')).toBeNull();
  });
});
