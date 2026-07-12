/**
 * Tests for WolPanel MAC-field validation (#1381).
 *
 * The MAC Address field is routed through the shared {@link NetworkTextField};
 * a malformed MAC surfaces the inline error and blocks Send, while a valid MAC
 * clears the error and enables it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import { WolPanel } from "./WolPanel";

vi.mock("@/services/networkApi", () => ({
  networkWolSend: vi.fn(() => Promise.resolve()),
  networkWolDevicesList: vi.fn(() => Promise.resolve([])),
  networkWolDeviceSave: vi.fn(() => Promise.resolve()),
  networkWolDeviceDelete: vi.fn(() => Promise.resolve()),
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
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function sendButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="wol-send"]')!;
}

function macInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="wol-mac"]')!;
}

async function renderPanel() {
  await act(async () => {
    root.render(withTooltip(<WolPanel />));
  });
  await flush();
}

describe("WolPanel — MAC validation", () => {
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

  it("blocks Send while the MAC is empty", async () => {
    await renderPanel();
    expect(sendButton().disabled).toBe(true);
  });

  it("flags a malformed MAC inline and blocks Send", async () => {
    await renderPanel();
    await act(async () => setInputValue(macInput(), "zz:zz"));
    await flush();
    expect(sendButton().disabled).toBe(true);
    expect(container.querySelector(".network-panel__field-error")?.textContent).toContain(
      "valid MAC address"
    );
  });

  it("enables Send and clears the error for a valid MAC", async () => {
    await renderPanel();
    await act(async () => setInputValue(macInput(), "AA:BB:CC:DD:EE:FF"));
    await flush();
    expect(sendButton().disabled).toBe(false);
    expect(container.querySelector(".network-panel__field-error")).toBeNull();
  });
});
