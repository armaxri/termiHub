import { useState, useCallback, useMemo } from "react";
import { Play, StopCircle } from "lucide-react";
import {
  networkPortScan,
  networkPortScanCancel,
  onScanResult,
  onScanComplete,
  onScanError,
} from "@/services/networkApi";
import type { PortScanSummary } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { useNetworkTask, type NetworkTaskContext } from "@/hooks/useNetworkTask";

interface PortScannerPanelProps {
  prefillHost?: string;
}

interface ScanRow {
  host: string;
  port: number;
  state: string;
  latencyMs?: number;
}

/** Port Scanner diagnostic tab content. */
export function PortScannerPanel({ prefillHost }: PortScannerPanelProps) {
  const [host, setHost] = useState(prefillHost ?? "");
  const [ports, setPorts] = useState("22,80,443,8080,8443");
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [concurrency, setConcurrency] = useState(100);
  const [results, setResults] = useState<ScanRow[]>([]);
  const [summary, setSummary] = useState<PortScanSummary | null>(null);

  // Warn user before scanning a very large range.
  const portCount = ports.split(",").reduce((acc, part) => {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [a, b] = trimmed.split("-").map(Number);
      return acc + Math.max(0, (b ?? 0) - (a ?? 0) + 1);
    }
    return acc + 1;
  }, 0);

  const subscribe = useCallback(async ({ matchesTask, register, finish }: NetworkTaskContext) => {
    register(
      await onScanResult((p) => {
        if (!matchesTask(p.taskId)) return;
        setResults((prev) => [
          ...prev,
          { host: p.host, port: p.port, state: p.state, latencyMs: p.latencyMs },
        ]);
      })
    );
    register(
      await onScanComplete((p) => {
        if (!matchesTask(p.taskId)) return;
        setSummary(p.summary);
        finish("completed");
      })
    );
    register(
      await onScanError((p) => {
        if (!matchesTask(p.taskId)) return;
        finish("error", p.error);
      })
    );
  }, []);

  const { status, error, run, stop } = useNetworkTask({
    logScope: "port_scanner",
    start: useCallback(
      () => networkPortScan(host, ports, timeoutMs, concurrency),
      [host, ports, timeoutMs, concurrency]
    ),
    cancel: networkPortScanCancel,
    onReset: useCallback(() => {
      setResults([]);
      setSummary(null);
    }, []),
    subscribe,
  });

  const handleRun = useCallback(() => {
    if (portCount > 1000) {
      const confirmed = window.confirm(
        `Scanning ${portCount} ports may take several minutes. Continue?`
      );
      if (!confirmed) return;
    }
    void run();
  }, [portCount, run]);

  // Only show the Host column when results span more than one host
  // (single-host scans look cleaner without it). Memoised because results
  // can grow to tens of thousands of rows on a CIDR-range scan.
  const showHostColumn = useMemo(() => new Set(results.map((r) => r.host)).size > 1, [results]);

  const columns = showHostColumn
    ? [
        { key: "host", label: "Host" },
        { key: "port", label: "Port" },
        { key: "state", label: "State" },
        { key: "latencyMs", label: "Latency" },
      ]
    : [
        { key: "port", label: "Port" },
        { key: "state", label: "State" },
        { key: "latencyMs", label: "Latency" },
      ];

  const formattedRows = results.map((r) => ({
    host: r.host,
    port: r.port,
    state: r.state,
    latencyMs: r.latencyMs != null ? `${r.latencyMs}ms` : "—",
  }));

  return (
    <div className="network-panel" data-testid="port-scanner-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">Port Scanner</span>
        <div className="network-panel__actions">
          {status === "running" ? (
            <button className="network-panel__btn network-panel__btn--stop" onClick={stop}>
              <StopCircle size={14} />
              Stop
            </button>
          ) : (
            <button
              className="network-panel__btn network-panel__btn--run"
              onClick={handleRun}
              disabled={!host.trim()}
              data-testid="port-scanner-run"
            >
              <Play size={14} />
              Run
            </button>
          )}
        </div>
      </div>

      <div className="network-panel__form">
        <label className="network-panel__field">
          <span>Host / CIDR</span>
          <input
            className="network-panel__input"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.1, 10.0.0.0/24, example.com"
            data-testid="port-scanner-host"
          />
        </label>
        <label className="network-panel__field">
          <span>Ports</span>
          <input
            className="network-panel__input"
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
            placeholder="22,80,443,8080-8090"
            data-testid="port-scanner-ports"
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Timeout (ms)</span>
          <input
            className="network-panel__input"
            type="number"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Concurrency</span>
          <input
            className="network-panel__input"
            type="number"
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
          />
        </label>
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      <DiagnosticResultsTable
        columns={columns}
        rows={formattedRows}
        footer={
          summary
            ? `Scanned ${summary.total} ports in ${(summary.elapsedMs / 1000).toFixed(1)}s — ${summary.open} open, ${summary.closed} closed, ${summary.filtered} filtered${status === "canceled" ? " (scan canceled)" : ""}`
            : status === "running"
              ? `Scanning… ${results.length} ports checked`
              : null
        }
      />
    </div>
  );
}
