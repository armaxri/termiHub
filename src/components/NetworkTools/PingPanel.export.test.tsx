/**
 * Export-results test for the Ping panel (PROD-031).
 *
 * The Export button is disabled with no replies, and once replies stream in it
 * writes the replies as CSV through the shared save-dialog / writeTextFile path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));

const mockedSave = vi.mocked(save);
const mockedWriteTextFile = vi.mocked(writeTextFile);

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function exportBtn(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="ping-export"]')!;
}

async function emitResult(result: PingResult) {
  const cb = vi.mocked(onPingResult).mock.calls[0][0];
  await act(async () => {
    cb({ taskId: "task-1", result });
  });
  await flush();
}

describe("PingPanel — export", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("disables Export until there are replies, then writes CSV", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="example.com" />);
    });

    expect(exportBtn().disabled).toBe(true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="ping-start"]')!.click();
    });
    await flush();
    await emitResult({ seq: 1, latencyMs: 10, ttl: 64, timedOut: false, tcpFallback: false });

    expect(exportBtn().disabled).toBe(false);

    mockedSave.mockResolvedValue("/tmp/ping-example.com.csv");
    await act(async () => {
      exportBtn().click();
    });
    await flush();

    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "ping-example.com.csv" })
    );
    expect(mockedWriteTextFile).toHaveBeenCalledWith(
      "/tmp/ping-example.com.csv",
      "seq,latency_ms,ttl,timed_out,tcp_fallback\n1,10,64,false,false\n"
    );
  });
});
