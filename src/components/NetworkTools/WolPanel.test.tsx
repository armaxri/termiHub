/**
 * Tests for WolPanel after the Button-primitive migration.
 *
 * Covers that the migrated actions still run their backend calls and that the
 * previously-silent icon actions (wake / save / delete) now surface feedback
 * (toast on success/failure) per the reactive design rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  networkWolSend,
  networkWolDevicesList,
  networkWolDeviceDelete,
} from "@/services/networkApi";
import { toast, TooltipProvider } from "@/components/ui";
import { WolPanel } from "./WolPanel";

// jsdom lacks the observer/pointer-capture APIs Radix Tooltip touches when it
// mounts the tooltip-wrapped icon buttons; shim them so the panel renders.
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

vi.mock("@/services/networkApi", () => ({
  networkWolSend: vi.fn(() => Promise.resolve()),
  networkWolDevicesList: vi.fn(() => Promise.resolve([])),
  networkWolDeviceSave: vi.fn(() => Promise.resolve()),
  networkWolDeviceDelete: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Wrap so the shared Tooltip primitive finds its provider (zero delay). */
function withTooltip(ui: React.ReactElement): React.ReactElement {
  return <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>;
}

async function renderPanel() {
  await act(async () => {
    root.render(withTooltip(<WolPanel />));
  });
  await flush();
}

describe("WolPanel — Button migration", () => {
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

  it("renders the Send action as a shared Button primitive", async () => {
    await renderPanel();
    const send = container.querySelector<HTMLButtonElement>('[data-testid="wol-send"]')!;
    expect(send).not.toBeNull();
    expect(send.classList.contains("ui-btn")).toBe(true);
    expect(send.classList.contains("ui-btn--primary")).toBe(true);
    // Disabled while the MAC field is empty.
    expect(send.disabled).toBe(true);
  });

  it("sends a magic packet and shows an inline confirmation", async () => {
    await renderPanel();

    const macInput = container.querySelector<HTMLInputElement>('[data-testid="wol-mac"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(macInput, "AA:BB:CC:DD:EE:FF");
      macInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wol-send"]')!.click();
    });
    await flush();

    expect(networkWolSend).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF", "255.255.255.255", 9);
    expect(container.textContent).toContain("Magic packet sent to AA:BB:CC:DD:EE:FF");
  });

  it("toasts an error when waking a saved device fails", async () => {
    vi.mocked(networkWolDevicesList).mockResolvedValueOnce([
      { id: "d1", name: "NAS", mac: "11:22:33:44:55:66", broadcast: "255.255.255.255", port: 9 },
    ]);
    vi.mocked(networkWolSend).mockRejectedValueOnce(new Error("network down"));

    await renderPanel();

    const wakeBtn = container.querySelector<HTMLButtonElement>('[aria-label="Wake NAS"]')!;
    expect(wakeBtn).not.toBeNull();
    expect(wakeBtn.classList.contains("ui-btn--ghost")).toBe(true);

    await act(async () => {
      wakeBtn.click();
    });
    await flush();

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Wake failed"));
  });

  it("toasts on a successful device wake", async () => {
    vi.mocked(networkWolDevicesList).mockResolvedValueOnce([
      { id: "d1", name: "NAS", mac: "11:22:33:44:55:66", broadcast: "255.255.255.255", port: 9 },
    ]);

    await renderPanel();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Wake NAS"]')!.click();
    });
    await flush();

    expect(networkWolSend).toHaveBeenCalledWith("11:22:33:44:55:66", "255.255.255.255", 9);
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("NAS"));
  });

  it("toasts an error when deleting a saved device fails", async () => {
    vi.mocked(networkWolDevicesList).mockResolvedValueOnce([
      { id: "d1", name: "NAS", mac: "11:22:33:44:55:66", broadcast: "255.255.255.255", port: 9 },
    ]);
    vi.mocked(networkWolDeviceDelete).mockRejectedValueOnce(new Error("nope"));

    await renderPanel();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Delete NAS"]')!.click();
    });
    await flush();

    expect(networkWolDeviceDelete).toHaveBeenCalledWith("d1");
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Delete failed"));
  });
});
