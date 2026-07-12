/**
 * Regression test for the Port Scanner live open-count (#1359).
 *
 * The running footer showed only "ports checked". It must also surface a live
 * count of open ports found so far, so progress is visible before completion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { onScanResult } from "@/services/networkApi";
import { PortScannerPanel } from "./PortScannerPanel";
import type { PortState } from "@/types/network";

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

async function emitResult(port: number, state: PortState) {
  const cb = vi.mocked(onScanResult).mock.calls[0][0];
  await act(async () => {
    cb({ taskId: "task-1", host: "10.0.0.1", port, state });
  });
  await flush();
}

function footerText(): string {
  return container.querySelector('[data-testid="port-scanner-footer"]')?.textContent ?? "";
}

describe("PortScannerPanel — live open-count", () => {
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

  it("shows a running open-count while scanning", async () => {
    await act(async () => {
      root.render(<PortScannerPanel prefillHost="10.0.0.1" />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="port-scanner-run"]')!.click();
    });
    await flush();

    await emitResult(22, "open");
    await emitResult(80, "closed");
    await emitResult(443, "open");

    const text = footerText();
    expect(text).toContain("3 checked");
    expect(text).toContain("2 open");
  });
});
