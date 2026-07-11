/**
 * Design-system migration tests for the Network Tools panels (#1435).
 *
 * Every form field across Ping / Traceroute / Port Scanner / DNS / WoL / HTTP
 * Monitor must be composed from the shared `ui/` primitives:
 *  - text/number inputs render the shared {@link Input} (`.ui-input`),
 *  - labelled fields render the shared {@link Field} wrapper (`.ui-field`),
 *  - the DNS record-type dropdown routes through the shared {@link Select}
 *    (`.ui-select__trigger`), not a native `<select>`,
 *  - none of the retired bespoke `network-panel__input` / `network-panel__select`
 *    / `network-panel__field-error` markup remains.
 *
 * Preserved behaviors (autofocus-select, inline validation + button gating,
 * touched-until-error) are re-asserted here so the migration can't silently drop
 * them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import { PingPanel } from "./PingPanel";
import { TraceroutePanel } from "./TraceroutePanel";
import { PortScannerPanel } from "./PortScannerPanel";
import { DnsLookupPanel } from "./DnsLookupPanel";
import { WolPanel } from "./WolPanel";
import { HttpMonitorPanel } from "./HttpMonitorPanel";

vi.mock("@/services/networkApi", () => {
  const unlisten = () => {};
  const onEvent = () => Promise.resolve(unlisten);
  return {
    networkPingStart: vi.fn(() => Promise.resolve("task-1")),
    networkPingStop: vi.fn(() => Promise.resolve()),
    onPingResult: vi.fn(onEvent),
    onPingComplete: vi.fn(onEvent),
    onPingError: vi.fn(onEvent),
    networkTraceroute: vi.fn(() => Promise.resolve("task-1")),
    networkTracerouteCancel: vi.fn(() => Promise.resolve()),
    onTracerouteHop: vi.fn(onEvent),
    onTracerouteComplete: vi.fn(onEvent),
    onTracerouteError: vi.fn(onEvent),
    networkPortScan: vi.fn(() => Promise.resolve("task-1")),
    networkPortScanCancel: vi.fn(() => Promise.resolve()),
    onScanResult: vi.fn(onEvent),
    onScanComplete: vi.fn(onEvent),
    onScanError: vi.fn(onEvent),
    networkDnsLookup: vi.fn(() => Promise.resolve({ records: [], queryMs: 1 })),
    networkWolSend: vi.fn(() => Promise.resolve()),
    networkWolDevicesList: vi.fn(() => Promise.resolve([])),
    networkWolDeviceSave: vi.fn(() => Promise.resolve()),
    networkWolDeviceDelete: vi.fn(() => Promise.resolve()),
    networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-1")),
    networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
    networkHttpMonitorRemove: vi.fn(() => Promise.resolve()),
    networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
    networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
    networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
    onHttpMonitorCheck: vi.fn(onEvent),
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

function el(testId: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** No panel may keep the retired bespoke field markup. */
function expectNoBespokeFieldMarkup() {
  expect(container.querySelector(".network-panel__input")).toBeNull();
  expect(container.querySelector(".network-panel__select")).toBeNull();
  expect(container.querySelector(".network-panel__field-error")).toBeNull();
}

describe("Network Tools — shared ui/ primitives (#1435)", () => {
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

  it("Ping: text + numeric fields are shared Input, wrapped in shared Field", async () => {
    await render(<PingPanel prefillHost="example.com" />);

    expect(el("ping-host").classList.contains("ui-input")).toBe(true);
    for (const id of ["ping-interval", "ping-count"]) {
      const input = el(id) as HTMLInputElement;
      expect(input.classList.contains("ui-input")).toBe(true);
      expect(input.type).toBe("number");
    }
    // Field wrappers supply the label.
    expect(el("ping-host").closest(".ui-field")).not.toBeNull();
    expect(container.textContent).toContain("Host");
    expectNoBespokeFieldMarkup();
  });

  it("Ping: auto-focuses and selects the prefilled host (behavior preserved)", async () => {
    await render(<PingPanel prefillHost="10.0.0.1" />);
    const host = el("ping-host") as HTMLInputElement;
    expect(document.activeElement).toBe(host);
    expect(host.selectionStart).toBe(0);
    expect(host.selectionEnd).toBe("10.0.0.1".length);
  });

  it("Ping: clearing the interval flags it inline (Field error) and gates Start", async () => {
    await render(<PingPanel prefillHost="example.com" />);
    await act(async () => setValue(el("ping-interval") as HTMLInputElement, ""));
    await flush();

    expect((el("ping-start") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector(".ui-field__msg")).not.toBeNull();
    expect(container.textContent).toContain("Interval is required");
  });

  it("Traceroute: host + max-hops fields are shared primitives", async () => {
    await render(<TraceroutePanel />);
    expect(el("traceroute-host").classList.contains("ui-input")).toBe(true);
    const maxHops = el("traceroute-max-hops") as HTMLInputElement;
    expect(maxHops.classList.contains("ui-input")).toBe(true);
    expect(maxHops.type).toBe("number");
    expectNoBespokeFieldMarkup();
  });

  it("Port Scanner: host, ports, and numeric fields are shared primitives", async () => {
    await render(<PortScannerPanel />);
    for (const id of ["port-scanner-host", "port-scanner-ports"]) {
      expect(el(id).classList.contains("ui-input")).toBe(true);
    }
    for (const id of ["port-scanner-timeout", "port-scanner-concurrency"]) {
      const input = el(id) as HTMLInputElement;
      expect(input.classList.contains("ui-input")).toBe(true);
      expect(input.type).toBe("number");
    }
    expectNoBespokeFieldMarkup();
  });

  it("DNS: hostname is a shared Input and record type is a shared Select", async () => {
    await render(<DnsLookupPanel />);
    expect(el("dns-hostname").classList.contains("ui-input")).toBe(true);

    const recordType = el("dns-record-type");
    expect(recordType.classList.contains("ui-select__trigger")).toBe(true);
    // Radix renders the selected value's label into the trigger.
    expect(recordType.textContent).toContain("A");
    // The native <select> is gone.
    expect(container.querySelector("select")).toBeNull();
    expectNoBespokeFieldMarkup();
  });

  it("WoL: MAC, broadcast, and port fields are shared primitives", async () => {
    await render(<WolPanel />);
    expect(el("wol-mac").classList.contains("ui-input")).toBe(true);
    expect(el("wol-broadcast").classList.contains("ui-input")).toBe(true);
    const port = el("wol-port") as HTMLInputElement;
    expect(port.classList.contains("ui-input")).toBe(true);
    expect(port.type).toBe("number");
    expectNoBespokeFieldMarkup();
  });

  it("HTTP Monitor: URL is a shared Input, method is a shared Select, numerics are shared", async () => {
    await render(<HttpMonitorPanel />);
    expect(el("http-monitor-url").classList.contains("ui-input")).toBe(true);
    for (const id of [
      "http-monitor-interval",
      "http-monitor-expected-status",
      "http-monitor-timeout",
    ]) {
      const input = el(id) as HTMLInputElement;
      expect(input.classList.contains("ui-input")).toBe(true);
      expect(input.type).toBe("number");
    }
    // Method dropdown is the shared Select, not a native <select>.
    expect(container.querySelector(".ui-select__trigger")).not.toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expectNoBespokeFieldMarkup();
  });
});
