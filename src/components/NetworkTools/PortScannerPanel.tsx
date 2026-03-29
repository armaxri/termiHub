import { useState, useEffect, useCallback, useRef } from "react";
import { Play, StopCircle } from "lucide-react";
import {
  networkPortScan,
  networkPortScanCancel,
  onScanResult,
  onScanComplete,
} from "@/services/networkApi";
import type { PortScanSummary, DiagnosticStatus } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { frontendLog } from "@/utils/frontendLog";

interface PortScannerPanelProps {
  prefillHost?: string;
}

interface ScanRow {
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
  const [status, setStatus] = useState<DiagnosticStatus>("idle");
  const [results, setResults] = useState<ScanRow[]>([]);
  const [summary, setSummary] = useState<PortScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const taskIdRef = useRef<string | null>(null);

  // Warn user before scanning a very large range.
  const portCount = ports.split(",").reduce((acc, part) => {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [a, b] = trimmed.split("-").map(Number);
      return acc + Math.max(0, (b ?? 0) - (a ?? 0) + 1);
    }
    return acc + 1;
  }, 0);

  const handleRun = useCallback(async () => {
    if (!host.trim()) return;
    if (portCount > 1000) {
      const confirmed = window.confirm(
        `Scanning ${portCount} ports may take several minutes. Continue?`
      );
      if (!confirmed) return;
    }

    setStatus("running");
    setResults([]);
    setSummary(null);
    setError(null);

    try {
      const taskId = await networkPortScan(host, ports, timeoutMs, concurrency);
      taskIdRef.current = taskId;

      const unlistenResult = await onScanResult((payload) => {
        if (payload.taskId !== taskId) return;
        setResults((prev) => [
          ...prev,
          { port: payload.port, state: payload.state, latencyMs: payload.latencyMs },
        ]);
      });

      const unlistenComplete = await onScanComplete((payload) => {
        if (payload.taskId !== taskId) return;
        setSummary(payload.summary);
        setStatus("completed");
        unlistenResult();
        unlistenComplete();
        taskIdRef.current = null;
      });
    } catch (err) {
      setError(String(err));
      setStatus("error");
      frontendLog("port_scanner", `Scan failed: ${err}`);
    }
  }, [host, ports, timeoutMs, concurrency, portCount]);

  const handleStop = useCallback(async () => {
    if (!taskIdRef.current) return;
    try {
      await networkPortScanCancel(taskIdRef.current);
    } catch (err) {
      frontendLog("port_scanner", `Cancel failed: ${err}`);
    }
    setStatus("canceled");
    taskIdRef.current = null;
  }, []);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      if (taskIdRef.current) {
        void networkPortScanCancel(taskIdRef.current).catch(() => {});
      }
    };
  }, []);

  const columns = [
    { key: "port", label: "Port" },
    { key: "state", label: "State" },
    { key: "latencyMs", label: "Latency" },
  ];

  const formattedRows = results.map((r) => ({
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
            <button className="network-panel__btn network-panel__btn--stop" onClick={handleStop}>
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
          <span>Host</span>
          <input
            className="network-panel__input"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.1"
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
