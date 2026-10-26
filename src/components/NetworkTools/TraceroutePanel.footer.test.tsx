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

  it("tags each hop row and cell so the live suite can read them (#4964)", async () => {
    await act(async () => {
      root.render(<TraceroutePanel prefillHost="example.com" />);
    });
    await start();
    await emitHop({ hop: 1, ip: "10.0.0.1", rttMs: [1.25, null, 3] });

    const cell = (key: string) =>
      container.querySelector(`[data-testid="traceroute-hop-0-${key}"]`)?.textContent;
    expect(container.querySelector('[data-testid="traceroute-hop-0"]')).not.toBeNull();
    expect(cell("hop")).toBe("1");
    expect(cell("ip")).toBe("10.0.0.1");
    expect(cell("rtt1")).toBe("1.3ms");
    expect(cell("rtt2")).toBe("—");
    expect(cell("rtt3")).toBe("3.0ms");
  });
});
