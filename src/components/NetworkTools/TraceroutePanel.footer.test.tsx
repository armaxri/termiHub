/**
 * Regression tests for the Traceroute footer (#1359):
 *  - the completed footer never renders "NaN"/a misleading "avg 0ms" when the
 *    last hop had no valid RTT, and
 *  - a "canceled" footer appears after Stop (previously the table just froze).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkTraceroute, onTracerouteHop, onTracerouteComplete } from "@/services/networkApi";
import { TraceroutePanel } from "./TraceroutePanel";
import type { TracerouteHop } from "@/types/network";

vi.mock("@/services/networkApi", () => ({
  networkTraceroute: vi.fn(() => Promise.resolve("task-1")),
  networkTracerouteCancel: vi.fn(() => Promise.resolve()),
  onTracerouteHop: vi.fn(() => Promise.resolve(() => {})),
  onTracerouteComplete: vi.fn(() => Promise.resolve(() => {})),
  onTracerouteError: vi.fn(() => Promise.resolve(() => {})),
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
    container.querySelector<HTMLButtonElement>('[data-testid="traceroute-run"]')!.click();
  });
  await flush();
}

async function emitHop(hop: TracerouteHop) {
  const cb = vi.mocked(onTracerouteHop).mock.calls[0][0];
  await act(async () => {
    cb({ taskId: "task-1", hop });
  });
  await flush();
}

async function emitComplete() {
  const cb = vi.mocked(onTracerouteComplete).mock.calls[0][0];
  await act(async () => {
    cb({ taskId: "task-1" });
  });
  await flush();
}

function footerText(): string {
  return container.querySelector('[data-testid="traceroute-footer"]')?.textContent ?? "";
}

describe("TraceroutePanel — footer", () => {
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

  it("omits the average (no NaN, no misleading 0ms) when the last hop has no valid RTT", async () => {
    await act(async () => {
      root.render(<TraceroutePanel prefillHost="example.com" />);
    });
    await start();
    await emitHop({ hop: 1, ip: undefined, rttMs: [null, null, null] });
    await emitComplete();

    const text = footerText();
    expect(text).toContain("Trace complete");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("avg");
  });

  it("shows the average when the last hop has valid RTTs", async () => {
    await act(async () => {
      root.render(<TraceroutePanel prefillHost="example.com" />);
    });
    await start();
    await emitHop({ hop: 1, ip: "1.1.1.1", rttMs: [10, 20, 30] });
    await emitComplete();

    expect(footerText()).toContain("avg 20ms");
  });

  it("never renders NaN when the trace completes with zero hops", async () => {
    await act(async () => {
      root.render(<TraceroutePanel prefillHost="example.com" />);
    });
    await start();
    await emitComplete();

    expect(footerText()).not.toContain("NaN");
  });

  it("appends a canceled footer after Stop", async () => {
    await act(async () => {
      root.render(<TraceroutePanel prefillHost="example.com" />);
    });
    await start();
    await emitHop({ hop: 1, ip: "1.1.1.1", rttMs: [10, 20, 30] });

    // Stop is the danger-variant button shown while running.
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".ui-btn--danger")!.click();
    });
    await flush();

    expect(footerText().toLowerCase()).toContain("canceled");
    expect(networkTraceroute).toHaveBeenCalledTimes(1);
  });
});
