/**
 * Regression test for Open Ports auto-load on mount (#1359).
 *
 * The panel used to open empty and required a manual Refresh. It now lists the
 * listening ports automatically when mounted (Refresh remains for re-fetch).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkOpenPorts } from "@/services/networkApi";
import { OpenPortsPanel } from "./OpenPortsPanel";

vi.mock("@/services/networkApi", () => ({
  networkOpenPorts: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("OpenPortsPanel — auto-load", () => {
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

  it("lists ports automatically on mount without a manual Refresh", async () => {
    vi.mocked(networkOpenPorts).mockResolvedValueOnce([
      { protocol: "TCP", localAddr: "0.0.0.0:22", pid: 100, process: "sshd" },
    ]);

    await act(async () => {
      root.render(<OpenPortsPanel />);
    });
    await flush();

    expect(networkOpenPorts).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("sshd");
    // The click-to-refresh placeholder is gone once auto-loaded.
    expect(container.textContent).not.toContain("Click Refresh");
  });

  it("Refresh re-fetches after the initial auto-load", async () => {
    await act(async () => {
      root.render(<OpenPortsPanel />);
    });
    await flush();
    expect(networkOpenPorts).toHaveBeenCalledTimes(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-ports-refresh"]')!.click();
    });
    await flush();

    expect(networkOpenPorts).toHaveBeenCalledTimes(2);
  });
});
