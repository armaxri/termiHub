/**
 * Regression tests for TraceroutePanel error handling and the
 * listeners-before-start ordering (same race that hung the Ping panel).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  networkTraceroute,
  onTracerouteHop,
  onTracerouteComplete,
  onTracerouteError,
} from "@/services/networkApi";
import { TraceroutePanel } from "./TraceroutePanel";

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

describe("TraceroutePanel — error handling", () => {
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
      root.render(<TraceroutePanel prefillHost="does-not-exist.invalid" />);
    });
    await start();

    const startOrder = vi.mocked(networkTraceroute).mock.invocationCallOrder[0];
    expect(vi.mocked(onTracerouteHop).mock.invocationCallOrder[0]).toBeLessThan(startOrder);
    expect(vi.mocked(onTracerouteComplete).mock.invocationCallOrder[0]).toBeLessThan(startOrder);
    expect(vi.mocked(onTracerouteError).mock.invocationCallOrder[0]).toBeLessThan(startOrder);
  });

  it("leaves the running state and shows the error when the host fails", async () => {
    await act(async () => {
      root.render(<TraceroutePanel prefillHost="does-not-exist.invalid" />);
    });
    await start();

    // Running: Run button is gone (Stop shown).
    expect(container.querySelector('[data-testid="traceroute-run"]')).toBeNull();

    const errorCb = vi.mocked(onTracerouteError).mock.calls[0][0];
    await act(async () => {
      errorCb({ taskId: "task-1", error: "DNS resolution failed" });
    });
    await flush();

    expect(container.querySelector('[data-testid="traceroute-run"]')).not.toBeNull();
    expect(container.textContent).toContain("DNS resolution failed");
  });

  it("ignores errors for a different task id", async () => {
    await act(async () => {
      root.render(<TraceroutePanel prefillHost="host" />);
    });
    await start();

    const errorCb = vi.mocked(onTracerouteError).mock.calls[0][0];
    await act(async () => {
      errorCb({ taskId: "other", error: "unrelated" });
    });
    await flush();

    // Still running — the stray error was for another task.
    expect(container.querySelector('[data-testid="traceroute-run"]')).toBeNull();
  });
});
