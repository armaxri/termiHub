/**
 * Tests for the Ping Sweep large-range warning (#1936).
 *
 * Mirrors the Port Scanner's large-scan guard: a wide CIDR block warns before
 * sweeping, the sweep only starts once confirmed, cancelling aborts, and a
 * normal /24 does not trip the warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkPingSweep } from "@/services/networkApi";
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

function q<T extends Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
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

describe("PingSweepPanel — large-range warning", () => {
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

  it("does not warn for a normal /24", async () => {
    await renderPanel("192.168.1.0/24");
    await clickRun();

    expect(q('[data-testid="ping-sweep-warn-modal"]')).toBeNull();
    expect(networkPingSweep).toHaveBeenCalledTimes(1);
  });

  it("warns before a wide CIDR block and defers the sweep", async () => {
    await renderPanel("10.0.0.0/16");
    await clickRun();

    expect(q('[data-testid="ping-sweep-warn-modal"]')).not.toBeNull();
    expect(networkPingSweep).not.toHaveBeenCalled();
  });

  it("starts the sweep when the warning is confirmed", async () => {
    await renderPanel("10.0.0.0/16");
    await clickRun();

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="ping-sweep-warn-confirm"]')!.click();
    });
    await flush();

    expect(networkPingSweep).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="ping-sweep-warn-modal"]')).toBeNull();
  });

  it("aborts the sweep when the warning is cancelled", async () => {
    await renderPanel("10.0.0.0/16");
    await clickRun();

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="ping-sweep-warn-cancel"]')!.click();
    });
    await flush();

    expect(networkPingSweep).not.toHaveBeenCalled();
    expect(q('[data-testid="ping-sweep-warn-modal"]')).toBeNull();
  });
});
