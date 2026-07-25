/**
 * Tests for the "HTTP Monitors" section of the Open Connections panel (#1147,
 * GAP 9): running HTTP monitors were absent from the panel, contradicting its
 * "every live subsystem" mandate. The section is driven by the store's live
 * `httpMonitors` array (the single source of truth kept in sync by the Network
 * Tools sidebar / check events), listing each monitor with a per-row Stop and a
 * Kill-All wired to the stop actions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { HttpMonitorState } from "@/types/network";

// jsdom lacks the observer/pointer-capture APIs Radix Tooltip touches when it
// mounts its trigger; shim them so tooltip-wrapped controls render.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  xServerStatus: vi.fn(() =>
    Promise.resolve({ state: "absent", platform: "linux", managed: false })
  ),
  xServerStop: vi.fn(() => Promise.resolve()),
}));

const networkHttpMonitorStop = vi.fn((_id: string) => Promise.resolve());
const networkHttpMonitorStopAll = vi.fn(() => Promise.resolve());
const networkHttpMonitorList = vi.fn(() => Promise.resolve([] as HttpMonitorState[]));
vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStop: (id: string) => networkHttpMonitorStop(id),
  networkHttpMonitorStopAll: () => networkHttpMonitorStopAll(),
  networkHttpMonitorList: () => networkHttpMonitorList(),
}));

import { OpenConnectionsModal } from "./OpenConnectionsModal";

function monitorState(id: string, url: string, ok: boolean): HttpMonitorState {
  return {
    config: {
      id,
      url,
      intervalMs: 5000,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 10000,
    },
    running: true,
    paused: false,
    lastResult: {
      monitorId: id,
      ok,
      statusCode: ok ? 200 : 503,
      latencyMs: 12,
      timestampMs: Date.now(),
    },
  };
}

function monitorSection(): HTMLElement | null {
  const title = Array.from(document.querySelectorAll(".oc-section__title")).find(
    (t) => t.textContent === "HTTP Monitors"
  );
  return (title?.closest("div")?.parentElement as HTMLElement) ?? null;
}

function monitorRows(): Element[] {
  return Array.from(monitorSection()?.querySelectorAll(".oc-row") ?? []);
}

describe("OpenConnectionsModal — HTTP Monitors section", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    networkHttpMonitorStop.mockClear();
    networkHttpMonitorStopAll.mockClear();
    networkHttpMonitorList.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderModal() {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
  }

  it("renders a row per running monitor from the store's httpMonitors", () => {
    useAppStore.setState({
      httpMonitors: [
        monitorState("m1", "https://up.example.com", true),
        monitorState("m2", "https://down.example.com", false),
      ],
    });

    renderModal();

    const titles = monitorRows().map((r) => r.querySelector(".oc-row__title")?.textContent);
    expect(titles.some((t) => t?.includes("https://up.example.com"))).toBe(true);
    expect(titles.some((t) => t?.includes("https://down.example.com"))).toBe(true);
  });

  it("shows an up/down badge derived from the last result", () => {
    useAppStore.setState({
      httpMonitors: [
        monitorState("m1", "https://up.example.com", true),
        monitorState("m2", "https://down.example.com", false),
      ],
    });

    renderModal();

    const badges = monitorRows().map((r) => r.querySelector(".oc-row__badge")?.textContent);
    expect(badges).toContain("up");
    expect(badges).toContain("down");
  });

  it("stops a single monitor via networkHttpMonitorStop", async () => {
    useAppStore.setState({
      httpMonitors: [monitorState("m1", "https://up.example.com", true)],
    });

    renderModal();

    const killBtn = monitorRows()[0]?.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      killBtn.click();
    });

    expect(networkHttpMonitorStop).toHaveBeenCalledWith("m1");
  });

  it("Kill-All stops every monitor via networkHttpMonitorStopAll", async () => {
    useAppStore.setState({
      httpMonitors: [
        monitorState("m1", "https://up.example.com", true),
        monitorState("m2", "https://down.example.com", false),
      ],
    });

    renderModal();

    const killAll = monitorSection()?.querySelector(".oc-section__kill-all") as HTMLButtonElement;
    await act(async () => {
      killAll.click();
    });

    // Bulk teardown now confirms first (#1343) — accept the dialog to proceed.
    const confirm = document.querySelector(
      '[data-testid="confirm-dialog-confirm"]'
    ) as HTMLButtonElement;
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm.click();
    });

    expect(networkHttpMonitorStopAll).toHaveBeenCalledTimes(1);
  });

  it("renders no HTTP Monitors section when there are no monitors", () => {
    renderModal();
    expect(monitorSection()).toBeNull();
  });
});
