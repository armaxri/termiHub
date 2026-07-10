/**
 * Tests for the Port Scanner large-scan warning after replacing the native
 * `window.confirm` with the shared Modal primitive (#1348).
 *
 * Covers: the confirm modal opens instead of a native confirm; the scan only
 * starts once confirmed; cancelling aborts; and the CIDR host-count is factored
 * into the estimate so a multi-host scan trips the warning even with few ports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkPortScan } from "@/services/networkApi";
import { PortScannerPanel } from "./PortScannerPanel";

vi.mock("@/services/networkApi", () => ({
  networkPortScan: vi.fn(() => Promise.resolve("task-1")),
  networkPortScanCancel: vi.fn(() => Promise.resolve()),
  onScanResult: vi.fn(() => Promise.resolve(() => {})),
  onScanComplete: vi.fn(() => Promise.resolve(() => {})),
  onScanError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Query into the modal, which Radix portals onto document.body. */
function q<T extends Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

async function renderPanel(props: { prefillHost?: string } = {}) {
  await act(async () => {
    root.render(<PortScannerPanel {...props} />);
  });
  await flush();
}

async function setPorts(value: string) {
  await act(async () => {
    setInputValue(
      container.querySelector<HTMLInputElement>('[data-testid="port-scanner-ports"]')!,
      value
    );
  });
  await flush();
}

async function clickRun() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="port-scanner-run"]')!.click();
  });
  await flush();
}

describe("PortScannerPanel — large-scan confirm modal (#1348)", () => {
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

  it("starts immediately for a small scan (no modal)", async () => {
    await renderPanel({ prefillHost: "192.168.1.1" });
    await clickRun();

    expect(q('[data-testid="port-scan-warn-modal"]')).toBeNull();
    expect(networkPortScan).toHaveBeenCalledTimes(1);
  });

  it("shows a confirm modal instead of window.confirm for a large port range", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    await renderPanel({ prefillHost: "192.168.1.1" });
    await setPorts("1-2000");
    await clickRun();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(q('[data-testid="port-scan-warn-modal"]')).not.toBeNull();
    // Scan must not start until the user confirms.
    expect(networkPortScan).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("starts the scan when the warning is confirmed", async () => {
    await renderPanel({ prefillHost: "192.168.1.1" });
    await setPorts("1-2000");
    await clickRun();

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="port-scan-warn-confirm"]')!.click();
    });
    await flush();

    expect(networkPortScan).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="port-scan-warn-modal"]')).toBeNull();
  });

  it("aborts the scan when the warning is cancelled", async () => {
    await renderPanel({ prefillHost: "192.168.1.1" });
    await setPorts("1-2000");
    await clickRun();

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="port-scan-warn-cancel"]')!.click();
    });
    await flush();

    expect(networkPortScan).not.toHaveBeenCalled();
    expect(q('[data-testid="port-scan-warn-modal"]')).toBeNull();
  });

  it("trips the warning for a CIDR block even with a small port list", async () => {
    // A single host across these ports is well under the threshold, but a /24
    // (256 hosts) pushes the probe count over it.
    await renderPanel({ prefillHost: "10.0.0.0/24" });
    await setPorts("22,80,443,8080,8443");
    await clickRun();

    expect(q('[data-testid="port-scan-warn-modal"]')).not.toBeNull();
    expect(networkPortScan).not.toHaveBeenCalled();
  });
});
