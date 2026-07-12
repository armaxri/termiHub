/**
 * Submit-lifecycle parity for the Network Tools panels (#1414).
 *
 * The primary action lives in a <form> as a `type="submit"` Button. Both entry
 * points must behave identically:
 *  - a mouse **click** drives the async Button lifecycle (pending affordance),
 *  - pressing **Enter** (form submit) drives the *same* pending affordance,
 *  - a single gate governs both paths (an invalid form runs neither).
 *
 * Before #1414 the Enter path ran the bare handler with no Button lifecycle, so
 * it showed no pending spinner — these tests are the regression guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import * as networkApi from "@/services/networkApi";
import { withTooltip } from "@/test/tooltip";
import { DnsLookupPanel } from "./DnsLookupPanel";
import { PingPanel } from "./PingPanel";

/** A promise whose resolution is controlled by the test, to freeze "pending". */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

vi.mock("@/services/networkApi", () => {
  const unlisten = () => {};
  const onEvent = () => Promise.resolve(unlisten);
  return {
    networkDnsLookup: vi.fn(() => Promise.resolve({ records: [], queryMs: 1 })),
    networkPingStart: vi.fn(() => Promise.resolve("task-1")),
    networkPingStop: vi.fn(() => Promise.resolve()),
    onPingResult: vi.fn(onEvent),
    onPingComplete: vi.fn(onEvent),
    onPingError: vi.fn(onEvent),
  };
});

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function render(node: React.ReactElement) {
  await act(async () => {
    root.render(withTooltip(node));
  });
  await flush();
}

function get<T extends HTMLElement>(testId: string): T {
  return container.querySelector<T>(`[data-testid="${testId}"]`)!;
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function fill(inputTestId: string, value: string) {
  await act(async () => setValue(get<HTMLInputElement>(inputTestId), value));
  await flush();
}

async function submit(formTestId: string) {
  await act(async () => {
    get<HTMLFormElement>(formTestId).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  });
  await flush();
}

async function click(buttonTestId: string) {
  await act(async () => {
    get<HTMLButtonElement>(buttonTestId).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
  });
  await flush();
}

/** True when the Button is showing its async pending affordance. */
function isPending(button: HTMLButtonElement): boolean {
  return (
    button.classList.contains("ui-btn--pending") && button.getAttribute("aria-busy") === "true"
  );
}

describe("Network Tools — submit lifecycle parity (#1414)", () => {
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

  it("DNS: clicking Run shows the pending affordance", async () => {
    const gate = deferred<{ records: never[]; queryMs: number }>();
    vi.mocked(networkApi.networkDnsLookup).mockReturnValueOnce(gate.promise);
    await render(<DnsLookupPanel />);
    await fill("dns-hostname", "example.com");

    await click("dns-run");

    expect(isPending(get<HTMLButtonElement>("dns-run"))).toBe(true);
    gate.resolve({ records: [], queryMs: 1 });
  });

  it("DNS: pressing Enter shows the SAME pending affordance as clicking", async () => {
    const gate = deferred<{ records: never[]; queryMs: number }>();
    vi.mocked(networkApi.networkDnsLookup).mockReturnValueOnce(gate.promise);
    await render(<DnsLookupPanel />);
    await fill("dns-hostname", "example.com");

    await submit("dns-lookup-panel");

    expect(networkApi.networkDnsLookup).toHaveBeenCalledTimes(1);
    expect(isPending(get<HTMLButtonElement>("dns-run"))).toBe(true);
    gate.resolve({ records: [], queryMs: 1 });
  });

  it("DNS: an invalid form gates BOTH Enter and click (one shared gate)", async () => {
    await render(<DnsLookupPanel />);
    // Empty hostname → invalid. The submit Button must be disabled…
    expect(get<HTMLButtonElement>("dns-run").disabled).toBe(true);
    // …and neither Enter nor a click may run the lookup.
    await submit("dns-lookup-panel");
    await click("dns-run");
    expect(networkApi.networkDnsLookup).not.toHaveBeenCalled();
  });

  it("Ping (streaming): pressing Enter shows the pending affordance", async () => {
    const gate = deferred<string>();
    vi.mocked(networkApi.networkPingStart).mockReturnValueOnce(gate.promise);
    await render(<PingPanel />);
    await fill("ping-host", "example.com");

    await submit("ping-panel");

    expect(networkApi.networkPingStart).toHaveBeenCalledTimes(1);
    expect(isPending(get<HTMLButtonElement>("ping-start"))).toBe(true);
    gate.resolve("task-1");
  });
});
