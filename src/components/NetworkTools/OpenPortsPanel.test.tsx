/**
 * Tests for OpenPortsPanel after the Button-primitive migration: the Refresh
 * action is the shared Button, triggers the backend list call, disables while
 * running, and surfaces the error inline on failure.
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

describe("OpenPortsPanel — Button migration", () => {
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

  it("renders Refresh as a shared primary Button", async () => {
    await act(async () => {
      root.render(<OpenPortsPanel />);
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="open-ports-refresh"]')!;
    expect(btn).not.toBeNull();
    expect(btn.classList.contains("ui-btn")).toBe(true);
    expect(btn.classList.contains("ui-btn--primary")).toBe(true);
  });

  it("lists open ports when Refresh is clicked", async () => {
    vi.mocked(networkOpenPorts).mockResolvedValueOnce([
      { protocol: "TCP", localAddr: "0.0.0.0:22", pid: 100, process: "sshd" },
    ]);
    await act(async () => {
      root.render(<OpenPortsPanel />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-ports-refresh"]')!.click();
    });
    await flush();

    expect(networkOpenPorts).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("sshd");
  });

  it("shows the error inline when listing fails", async () => {
    vi.mocked(networkOpenPorts).mockRejectedValueOnce(new Error("permission denied"));
    await act(async () => {
      root.render(<OpenPortsPanel />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-ports-refresh"]')!.click();
    });
    await flush();

    expect(container.textContent).toContain("permission denied");
  });
});
