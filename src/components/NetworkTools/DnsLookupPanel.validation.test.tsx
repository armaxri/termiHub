/**
 * Tests for DnsLookupPanel field validation (#1381).
 *
 * The Hostname (and optional Server) fields are composed from the shared ui
 * {@link Field} + {@link Input} primitives; a cleared hostname surfaces the
 * inline error and blocks Run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { DnsLookupPanel } from "./DnsLookupPanel";

vi.mock("@/services/networkApi", () => ({
  networkDnsLookup: vi.fn(() => Promise.resolve({ records: [], queryMs: 0 })),
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
  return container.querySelector<HTMLButtonElement>('[data-testid="dns-run"]')!;
}

function hostnameInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="dns-hostname"]')!;
}

function fieldError(): Element | null {
  return container.querySelector(".ui-field__msg");
}

describe("DnsLookupPanel — hostname validation", () => {
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

  it("blocks Run when the hostname is empty", async () => {
    await act(async () => {
      root.render(<DnsLookupPanel />);
    });
    expect(runButton().disabled).toBe(true);
  });

  it("routes the Server field through the shared field component", async () => {
    await act(async () => {
      root.render(<DnsLookupPanel />);
    });
    expect(container.querySelector('[data-testid="dns-server"]')).not.toBeNull();
  });

  it("renders the hostname through the shared field and flags it inline once cleared", async () => {
    await act(async () => {
      root.render(<DnsLookupPanel prefillHost="example.com" />);
    });
    await act(async () => setInputValue(hostnameInput(), ""));
    expect(runButton().disabled).toBe(true);
    expect(fieldError()?.textContent).toContain("Hostname is required");
  });
});
