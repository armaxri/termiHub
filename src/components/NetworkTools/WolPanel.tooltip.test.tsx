/**
 * Verifies the Wake-on-LAN saved-device row adopts the shared `Tooltip`
 * primitive for its icon-only Wake/Delete controls (issue #1102).
 *
 * A tooltip is not an accessible name, so each converted icon button must keep
 * an `aria-label`, and the Radix tooltip trigger must wire `aria-describedby`
 * when focused. These assertions pin both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkWolDevicesList } from "@/services/networkApi";
import type { WolDevice } from "@/types/network";
import { WolPanel } from "./WolPanel";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkWolSend: vi.fn(() => Promise.resolve()),
  networkWolDevicesList: vi.fn(() => Promise.resolve([])),
  networkWolDeviceSave: vi.fn(() => Promise.resolve()),
  networkWolDeviceDelete: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const DEVICE: WolDevice = {
  id: "dev-1",
  name: "Office NAS",
  mac: "AA:BB:CC:DD:EE:FF",
  broadcast: "255.255.255.255",
  port: 9,
};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("WolPanel — tooltip adoption (#1102)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(networkWolDevicesList).mockResolvedValue([DEVICE]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("exposes accessible names via aria-label on the Wake and Delete icon buttons", async () => {
    await act(async () => {
      root.render(withTooltip(<WolPanel />));
    });
    await flush();

    const wake = container.querySelector<HTMLButtonElement>('button[aria-label="Wake Office NAS"]');
    const del = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Office NAS"]'
    );
    expect(wake).not.toBeNull();
    expect(del).not.toBeNull();
    // The tooltip must not leak into the accessible name as a bare title.
    expect(wake?.getAttribute("title")).toBeNull();
    expect(del?.getAttribute("title")).toBeNull();
  });

  it("wires the Wake button to its tooltip via aria-describedby on focus", async () => {
    await act(async () => {
      root.render(withTooltip(<WolPanel />));
    });
    await flush();

    const wake = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Wake Office NAS"]'
    )!;
    act(() => {
      wake.focus();
      wake.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });

    // Radix associates the open tooltip with its trigger for screen readers.
    expect(wake.getAttribute("aria-describedby")).toBeTruthy();
  });
});
