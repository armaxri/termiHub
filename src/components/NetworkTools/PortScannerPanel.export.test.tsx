/**
 * Export-results test for the Port Scanner panel (PROD-031).
 *
 * Covers the tabular CSV shape: Export is disabled with no results, and once
 * results stream in it writes host/port/state/latency rows through the shared
 * save-dialog / writeTextFile path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
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
  return container.querySelector<HTMLButtonElement>('[data-testid="port-scanner-export"]')!;
}

async function emitResult(port: number, state: PortState, latencyMs?: number) {
  const cb = vi.mocked(onScanResult).mock.calls[0][0];
  await act(async () => {
    cb({ taskId: "task-1", host: "10.0.0.1", port, state, latencyMs });
  });
  await flush();
}

describe("PortScannerPanel — export", () => {
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

  it("disables Export until there are results, then writes CSV", async () => {
    await act(async () => {
      root.render(<PortScannerPanel prefillHost="10.0.0.1" />);
    });

    expect(exportBtn().disabled).toBe(true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="port-scanner-run"]')!.click();
    });
    await flush();
    await emitResult(22, "open", 3);
    await emitResult(80, "closed");

    expect(exportBtn().disabled).toBe(false);

    mockedSave.mockResolvedValue("/tmp/port-scan-10.0.0.1.csv");
    await act(async () => {
      exportBtn().click();
    });
    await flush();

    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "port-scan-10.0.0.1.csv" })
    );
    expect(mockedWriteTextFile).toHaveBeenCalledWith(
      "/tmp/port-scan-10.0.0.1.csv",
      "host,port,state,latency_ms\n10.0.0.1,22,open,3\n10.0.0.1,80,closed,\n"
    );
  });
});
