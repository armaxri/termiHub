/**
 * Regression tests for the DNS Lookup timeout / cancel affordance (#1359).
 *
 * A one-shot DNS query with no cancel would hang the panel on a stuck resolver.
 * The panel now bounds the query with a visible timeout and offers a Cancel
 * button while the lookup is in flight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkDnsLookup } from "@/services/networkApi";
import { DnsLookupPanel } from "./DnsLookupPanel";

vi.mock("@/services/networkApi", () => ({
  networkDnsLookup: vi.fn(),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function run() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="dns-run"]')!.click();
  });
  await flush();
}

describe("DnsLookupPanel — timeout / cancel", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("offers a Cancel button while the lookup is in flight and reports the cancel", async () => {
    // Never resolves — simulates a hung resolver.
    vi.mocked(networkDnsLookup).mockReturnValue(new Promise(() => {}));

    await act(async () => {
      root.render(<DnsLookupPanel prefillHost="example.com" />);
    });
    await run();

    const cancelBtn = container.querySelector<HTMLButtonElement>('[data-testid="dns-cancel"]');
    expect(cancelBtn).not.toBeNull();

    await act(async () => {
      cancelBtn!.click();
    });
    await flush();

    expect(container.textContent?.toLowerCase()).toContain("cancel");
    // The Cancel affordance is gone once the lookup ends.
    expect(container.querySelector('[data-testid="dns-cancel"]')).toBeNull();
  });

  it("times out a hung query with a visible error", async () => {
    vi.useFakeTimers();
    vi.mocked(networkDnsLookup).mockReturnValue(new Promise(() => {}));

    await act(async () => {
      root.render(<DnsLookupPanel prefillHost="example.com" />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="dns-run"]')!.click();
    });

    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent?.toLowerCase()).toContain("timed out");
  });
});
