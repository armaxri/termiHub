import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import type { DnsRecord, PingResult, TracerouteHop } from "@/types/network";

/** A single scanned host/port result, as rendered by the Port Scanner panel. */
export interface PortScanExportRow {
  host: string;
  port: number;
  state: string;
  latencyMs?: number;
}

/** A CSV cell value; nullish renders as an empty cell. */
type CsvValue = string | number | boolean | null | undefined;

/** Escape a single CSV cell per RFC 4180 (quote when it holds `,`, `"`, or newline). */
function csvCell(value: CsvValue): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Build a trailing-newline CSV document from a header row and data rows. */
function toCsv(header: string[], rows: CsvValue[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

/** Serialize ping replies to CSV (one row per reply). */
export function pingResultsToCsv(results: PingResult[]): string {
  return toCsv(
    ["seq", "latency_ms", "ttl", "timed_out", "tcp_fallback"],
    results.map((r) => [r.seq, r.latencyMs ?? "", r.ttl ?? "", r.timedOut, r.tcpFallback])
  );
}

/** Serialize traceroute hops to CSV (one row per hop, three RTT columns). */
export function tracerouteHopsToCsv(hops: TracerouteHop[]): string {
  return toCsv(
    ["hop", "host", "rtt1_ms", "rtt2_ms", "rtt3_ms"],
    hops.map((h) => [
      h.hop,
      h.ip ?? h.host ?? "",
      h.rttMs[0] ?? "",
      h.rttMs[1] ?? "",
      h.rttMs[2] ?? "",
    ])
  );
}

/** Serialize port-scan results to CSV (one row per probed port). */
export function portScanResultsToCsv(results: PortScanExportRow[]): string {
  return toCsv(
    ["host", "port", "state", "latency_ms"],
    results.map((r) => [r.host, r.port, r.state, r.latencyMs ?? ""])
  );
}

/** Serialize DNS records to CSV (one row per record). */
export function dnsRecordsToCsv(records: DnsRecord[]): string {
  return toCsv(
    ["type", "name", "value", "ttl"],
    records.map((r) => [r.recordType, r.name, r.value, r.ttl])
  );
}

/**
 * Prompt for a save location and write network-tool results to it, reusing the
 * app's standard save-dialog + `writeTextFile` plumbing (same as LogViewer).
 *
 * Toasts success on write, and a recoverable error toast on failure. A cancelled
 * dialog (no path chosen) is a no-op with no toast.
 *
 * @param defaultBaseName File name stem, without extension (e.g. `ping-example.com`).
 * @param content The full file contents to write.
 * @param extension File extension without the dot (defaults to `csv`).
 */
export async function exportNetworkResults(
  defaultBaseName: string,
  content: string,
  extension = "csv"
): Promise<void> {
  try {
    // Hosts may contain path-hostile characters (a CIDR's `/`, IPv6 `:`); keep
    // the suggested file name filesystem-safe.
    const safeName = defaultBaseName.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "results";
    const filePath = await save({
      title: "Export results",
      defaultPath: `${safeName}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (!filePath) return; // user cancelled the dialog
    await writeTextFile(filePath, content);
    toast.success("Results exported");
  } catch (err) {
    frontendLog("network_export", `Export failed: ${err}`);
    toast.error("Failed to export results");
  }
}
