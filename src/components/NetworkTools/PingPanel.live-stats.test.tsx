/**
 * Regression test for live ping statistics (#1359).
 *
 * The panel used to hide loss % / avg-min-max RTT until the backend's closing
 * stats arrived on Stop. It must now surface running stats derived from the
 * streamed replies while the ping is still running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { onPingResult } from "@/services/networkApi";
import { PingPanel } from "./PingPanel";
import type { PingResult } from "@/types/network";

vi.mock("@/services/networkApi", () => ({
  networkPingStart: vi.fn(() => Promise.resolve("task-1")),
  networkPingStop: vi.fn(() => Promise.resolve()),
  onPingResult: vi.fn(() => Promise.resolve(() => {})),
  onPingComplete: vi.fn(() => Promise.resolve(() => {})),
  onPingError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function emitResult(result: PingResult) {
  const cb = vi.mocked(onPingResult).mock.calls[0][0];
  await act(async () => {
    cb({ taskId: "task-1", result });
  });
  await flush();
}

function statsText(): string {
  return container.querySelector('[data-testid="ping-stats"]')?.textContent ?? "";
}

describe("PingPanel — live stats", () => {
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

  it("shows running loss % and RTT stats derived from streamed replies", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="example.com" />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="ping-start"]')!.click();
    });
    await flush();

    await emitResult({ seq: 1, latencyMs: 10, timedOut: false, tcpFallback: false });
    await emitResult({ seq: 2, timedOut: true, tcpFallback: false });
    await emitResult({ seq: 3, latencyMs: 30, timedOut: false, tcpFallback: false });

    const text = statsText();
    // 3 sent, 2 received → 33.3% loss; avg (10+30)/2 = 20ms.
    expect(text).toContain("Sent: 3");
    expect(text).toContain("Received: 2");
    expect(text).toContain("Loss: 33.3%");
    expect(text).toContain("avg=20ms");
    expect(text).not.toContain("NaN");
  });
});
