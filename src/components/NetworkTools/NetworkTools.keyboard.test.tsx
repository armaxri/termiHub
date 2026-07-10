/**
 * Keyboard-interaction tests for the Network Tools panels (#1341).
 *
 * Every tool must:
 *  - wrap its fields in a <form> so submitting (Enter) runs the tool,
 *  - respect the disabled/validation state (an invalid form must not run),
 *  - auto-focus (and text-select any prefill of) its primary input on mount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import * as networkApi from "@/services/networkApi";
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

// LatencyChart draws to a canvas jsdom can't back (uPlot needs matchMedia); stub it.
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

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(formTestId: string) {
  const form = container.querySelector<HTMLFormElement>(`[data-testid="${formTestId}"]`)!;
  expect(form.tagName).toBe("FORM");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

async function fillAndSubmit(inputTestId: string, formTestId: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="${inputTestId}"]`)!;
  await act(async () => setValue(input, value));
  await flush();
  await act(async () => submit(formTestId));
  await flush();
}

describe("Network Tools — keyboard interaction (#1341)", () => {
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

  it("Ping: Enter (form submit) starts the ping", async () => {
    await render(<PingPanel />);
    await fillAndSubmit("ping-host", "ping-panel", "example.com");
    expect(networkApi.networkPingStart).toHaveBeenCalled();
  });

  it("Ping: an empty host does not start on submit", async () => {
    await render(<PingPanel />);
    await act(async () => submit("ping-panel"));
    await flush();
    expect(networkApi.networkPingStart).not.toHaveBeenCalled();
  });

  it("Ping: auto-focuses and selects the prefilled host on mount", async () => {
    await render(<PingPanel prefillHost="10.0.0.1" />);
    const host = container.querySelector<HTMLInputElement>('[data-testid="ping-host"]')!;
    expect(document.activeElement).toBe(host);
    expect(host.selectionStart).toBe(0);
    expect(host.selectionEnd).toBe("10.0.0.1".length);
  });

  it("Traceroute: Enter runs the trace", async () => {
    await render(<TraceroutePanel />);
    await fillAndSubmit("traceroute-host", "traceroute-panel", "example.com");
    expect(networkApi.networkTraceroute).toHaveBeenCalled();
  });

  it("Traceroute: empty host does not run", async () => {
    await render(<TraceroutePanel />);
    await act(async () => submit("traceroute-panel"));
    await flush();
    expect(networkApi.networkTraceroute).not.toHaveBeenCalled();
  });

  it("Port Scanner: Enter runs the scan", async () => {
    await render(<PortScannerPanel />);
    await fillAndSubmit("port-scanner-host", "port-scanner-panel", "example.com");
    expect(networkApi.networkPortScan).toHaveBeenCalled();
  });

  it("DNS Lookup: Enter runs the lookup", async () => {
    await render(<DnsLookupPanel />);
    await fillAndSubmit("dns-hostname", "dns-lookup-panel", "example.com");
    expect(networkApi.networkDnsLookup).toHaveBeenCalled();
  });

  it("DNS Lookup: empty hostname does not run", async () => {
    await render(<DnsLookupPanel />);
    await act(async () => submit("dns-lookup-panel"));
    await flush();
    expect(networkApi.networkDnsLookup).not.toHaveBeenCalled();
  });

  it("WoL: Enter sends the magic packet", async () => {
    await render(<WolPanel />);
    await fillAndSubmit("wol-mac", "wol-panel", "AA:BB:CC:DD:EE:FF");
    expect(networkApi.networkWolSend).toHaveBeenCalled();
  });

  it("WoL: empty MAC does not send", async () => {
    await render(<WolPanel />);
    await act(async () => submit("wol-panel"));
    await flush();
    expect(networkApi.networkWolSend).not.toHaveBeenCalled();
  });

  it("HTTP Monitor: Enter starts the monitor", async () => {
    await render(<HttpMonitorPanel />);
    await fillAndSubmit("http-monitor-url", "http-monitor-panel", "https://example.com");
    expect(networkApi.networkHttpMonitorStart).toHaveBeenCalled();
  });

  it("HTTP Monitor: the placeholder URL does not start", async () => {
    await render(<HttpMonitorPanel />);
    // Leaves the default "https://" value in place — invalid, so submit is a no-op.
    await act(async () => submit("http-monitor-panel"));
    await flush();
    expect(networkApi.networkHttpMonitorStart).not.toHaveBeenCalled();
  });

  it("HTTP Monitor: auto-focuses the URL input on mount", async () => {
    await render(<HttpMonitorPanel />);
    const url = container.querySelector<HTMLInputElement>('[data-testid="http-monitor-url"]')!;
    expect(document.activeElement).toBe(url);
  });
});
