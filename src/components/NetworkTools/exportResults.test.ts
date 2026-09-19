/**
 * Unit tests for the shared network-tool result export helper (PROD-031).
 *
 * Covers the per-tool CSV formatters (shape + escaping) and the save-dialog /
 * writeTextFile plumbing, including the cancel (no path) and error paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  dnsRecordsToCsv,
  exportNetworkResults,
  pingResultsToCsv,
  portScanResultsToCsv,
  tracerouteHopsToCsv,
} from "./exportResults";
import type { DnsRecord, PingResult, TracerouteHop } from "@/types/network";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/components/ui", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const mockedSave = vi.mocked(save);
const mockedWriteTextFile = vi.mocked(writeTextFile);

describe("network export CSV formatters", () => {
  it("serializes ping replies with a header row", () => {
    const results: PingResult[] = [
      { seq: 1, latencyMs: 12.5, ttl: 64, timedOut: false, tcpFallback: false },
      { seq: 2, timedOut: true, tcpFallback: true },
    ];
    expect(pingResultsToCsv(results)).toBe(
      "seq,latency_ms,ttl,timed_out,tcp_fallback\n1,12.5,64,false,false\n2,,,true,true\n"
    );
  });

  it("serializes traceroute hops with three RTT columns", () => {
    const hops: TracerouteHop[] = [
      { hop: 1, ip: "10.0.0.1", rttMs: [1.1, 1.2, null] },
      { hop: 2, rttMs: [null, null, null] },
    ];
    expect(tracerouteHopsToCsv(hops)).toBe(
      "hop,host,rtt1_ms,rtt2_ms,rtt3_ms\n1,10.0.0.1,1.1,1.2,\n2,,,,\n"
    );
  });

  it("serializes port-scan rows", () => {
    expect(
      portScanResultsToCsv([
        { host: "10.0.0.1", port: 22, state: "open", latencyMs: 3 },
        { host: "10.0.0.1", port: 80, state: "closed" },
      ])
    ).toBe("host,port,state,latency_ms\n10.0.0.1,22,open,3\n10.0.0.1,80,closed,\n");
  });

  it("serializes DNS records and quotes cells containing commas", () => {
    const records: DnsRecord[] = [
      { recordType: "A", name: "example.com", value: "93.184.216.34", ttl: 300 },
      { recordType: "TXT", name: "example.com", value: "v=spf1, -all", ttl: 60 },
    ];
    expect(dnsRecordsToCsv(records)).toBe(
      'type,name,value,ttl\nA,example.com,93.184.216.34,300\nTXT,example.com,"v=spf1, -all",60\n'
    );
  });
});

describe("exportNetworkResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the content to the chosen path and toasts success", async () => {
    mockedSave.mockResolvedValue("/tmp/ping-example.com.csv");
    await exportNetworkResults("ping-example.com", "seq\n1\n");

    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "ping-example.com.csv" })
    );
    expect(mockedWriteTextFile).toHaveBeenCalledWith("/tmp/ping-example.com.csv", "seq\n1\n");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("sanitizes path-hostile characters in the suggested file name", async () => {
    mockedSave.mockResolvedValue(null);
    await exportNetworkResults("port-scan-10.0.0.0/24", "x");

    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "port-scan-10.0.0.0_24.csv" })
    );
  });

  it("is a no-op with no toast when the dialog is cancelled", async () => {
    mockedSave.mockResolvedValue(null);
    await exportNetworkResults("ping-example.com", "seq\n1\n");

    expect(mockedWriteTextFile).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("toasts a recoverable error when the write fails", async () => {
    mockedSave.mockResolvedValue("/tmp/out.csv");
    mockedWriteTextFile.mockRejectedValue(new Error("disk full"));
    await exportNetworkResults("ping-example.com", "seq\n1\n");

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
