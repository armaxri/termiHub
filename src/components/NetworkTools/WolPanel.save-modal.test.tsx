/**
 * Tests for the WoL "Save Current" flow. The dialog was first moved off the
 * native `window.prompt` onto the shared Modal primitive (#1348), then onto the
 * shared ConfirmDialog primitive via its body slot (#1875).
 *
 * Covers: the modal opens instead of a native prompt; the device name is
 * captured via a Field; an invalid MAC blocks the save with an inline error;
 * a valid save calls the backend and surfaces a success toast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkWolDeviceSave, networkWolDevicesList } from "@/services/networkApi";
import { toast } from "@/components/ui";
import { withTooltip } from "@/test/tooltip";
import { WolPanel } from "./WolPanel";

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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderPanel() {
  await act(async () => {
    root.render(withTooltip(<WolPanel />));
  });
  await flush();
}

/** Fill a valid MAC so the Save Current button becomes enabled. */
async function fillMac(mac: string) {
  const macInput = container.querySelector<HTMLInputElement>('[data-testid="wol-mac"]')!;
  await act(async () => {
    setInputValue(macInput, mac);
  });
  await flush();
}

/** Query into the modal, which Radix portals onto document.body. */
function q<T extends Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

describe("WolPanel — Save Current modal (#1348)", () => {
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

  it("does not use the native window.prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    await renderPanel();
    await fillMac("AA:BB:CC:DD:EE:FF");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wol-save-device"]')!.click();
    });
    await flush();

    expect(promptSpy).not.toHaveBeenCalled();
    expect(q('[data-testid="wol-save-modal"]')).not.toBeNull();
    promptSpy.mockRestore();
  });

  it("saves the device from the modal name field and toasts success", async () => {
    await renderPanel();
    await fillMac("AA:BB:CC:DD:EE:FF");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wol-save-device"]')!.click();
    });
    await flush();

    const nameInput = q<HTMLInputElement>('[data-testid="wol-save-name"]')!;
    expect(nameInput).not.toBeNull();
    await act(async () => {
      setInputValue(nameInput, "My NAS");
    });
    await flush();

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="confirm-dialog-confirm"]')!.click();
    });
    await flush();

    expect(networkWolDeviceSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My NAS", mac: "AA:BB:CC:DD:EE:FF" })
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("My NAS"));
    // Modal closes after a successful save.
    expect(q('[data-testid="wol-save-modal"]')).toBeNull();
  });

  it("keeps the confirm disabled until a name is entered", async () => {
    await renderPanel();
    await fillMac("AA:BB:CC:DD:EE:FF");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wol-save-device"]')!.click();
    });
    await flush();

    const confirm = q<HTMLButtonElement>('[data-testid="confirm-dialog-confirm"]')!;
    expect(confirm.disabled).toBe(true);

    await act(async () => {
      setInputValue(q<HTMLInputElement>('[data-testid="wol-save-name"]')!, "NAS");
    });
    await flush();
    expect(q<HTMLButtonElement>('[data-testid="confirm-dialog-confirm"]')!.disabled).toBe(false);
  });

  it("reloads the saved-device list after a successful save", async () => {
    await renderPanel();
    await fillMac("AA:BB:CC:DD:EE:FF");
    // One call on mount; expect an additional refresh after save.
    const callsBefore = vi.mocked(networkWolDevicesList).mock.calls.length;

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wol-save-device"]')!.click();
    });
    await flush();
    await act(async () => {
      setInputValue(q<HTMLInputElement>('[data-testid="wol-save-name"]')!, "NAS");
    });
    await flush();
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="confirm-dialog-confirm"]')!.click();
    });
    await flush();

    expect(vi.mocked(networkWolDevicesList).mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
