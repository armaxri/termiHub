/**
 * Tests for PortScannerPanel host/ports validation (#1381).
 *
 * The Host / CIDR and Ports fields are routed through the shared
 * {@link NetworkTextField}; clearing either one surfaces the inline error and
 * blocks Start.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function runButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="port-scanner-run"]')!;
}

function hostInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="port-scanner-host"]')!;
}

function portsInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="port-scanner-ports"]')!;
}

describe("PortScannerPanel — host/ports validation", () => {
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

  it("blocks Start when the host is empty", async () => {
    await act(async () => {
      root.render(<PortScannerPanel />);
    });
    expect(runButton().disabled).toBe(true);
  });

  it("flags the host inline and blocks Start once cleared", async () => {
    await act(async () => {
      root.render(<PortScannerPanel prefillHost="example.com" />);
    });
    await act(async () => setInputValue(hostInput(), ""));
    expect(runButton().disabled).toBe(true);
    expect(container.querySelector(".network-panel__field-error")?.textContent).toContain(
      "Host is required"
    );
  });

  it("flags the ports inline and blocks Start once cleared", async () => {
    await act(async () => {
      root.render(<PortScannerPanel prefillHost="example.com" />);
    });
    await act(async () => setInputValue(portsInput(), ""));
    expect(runButton().disabled).toBe(true);
    expect(container.textContent).toContain("at least one port");
  });

  it("enables Start with a valid host and default ports", async () => {
    await act(async () => {
      root.render(<PortScannerPanel prefillHost="example.com" />);
    });
    expect(runButton().disabled).toBe(false);
  });
});
