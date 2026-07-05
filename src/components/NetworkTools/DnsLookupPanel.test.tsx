/**
 * Tests for DnsLookupPanel after the Button-primitive migration: the Run action
 * is the shared Button, is disabled without a hostname, runs the lookup, and
 * surfaces the error inline on failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkDnsLookup } from "@/services/networkApi";
import { DnsLookupPanel } from "./DnsLookupPanel";

vi.mock("@/services/networkApi", () => ({
  networkDnsLookup: vi.fn(() => Promise.resolve({ records: [], queryMs: 0 })),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("DnsLookupPanel — Button migration", () => {
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

  it("renders Run as a shared primary Button, disabled without a hostname", async () => {
    await act(async () => {
      root.render(<DnsLookupPanel />);
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="dns-run"]')!;
    expect(btn).not.toBeNull();
    expect(btn.classList.contains("ui-btn")).toBe(true);
    expect(btn.classList.contains("ui-btn--primary")).toBe(true);
    expect(btn.disabled).toBe(true);
  });

  it("runs the lookup and renders records", async () => {
    vi.mocked(networkDnsLookup).mockResolvedValueOnce({
      records: [{ recordType: "A", name: "example.com", value: "93.184.216.34", ttl: 300 }],
      queryMs: 12,
    });
    await act(async () => {
      root.render(<DnsLookupPanel prefillHost="example.com" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="dns-run"]')!.click();
    });
    await flush();

    expect(networkDnsLookup).toHaveBeenCalledWith("example.com", "A", undefined);
    expect(container.textContent).toContain("93.184.216.34");
  });

  it("shows the error inline when the lookup fails", async () => {
    vi.mocked(networkDnsLookup).mockRejectedValueOnce(new Error("NXDOMAIN"));
    await act(async () => {
      root.render(<DnsLookupPanel prefillHost="does-not-exist.invalid" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="dns-run"]')!.click();
    });
    await flush();

    expect(container.textContent).toContain("NXDOMAIN");
  });
});
