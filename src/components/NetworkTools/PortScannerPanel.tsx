import { useState, useCallback, useMemo, type FormEvent } from "react";
import { Play, StopCircle } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import {
  networkPortScan,
  networkPortScanCancel,
  onScanResult,
  onScanComplete,
  onScanError,
} from "@/services/networkApi";
import type { PortScanSummary } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { NetworkNumberField } from "./NetworkNumberField";
import { validateIntRange } from "@/utils/fieldValidation";
import { estimateScanProbes } from "@/utils/scanEstimate";
import { useNetworkTask, type NetworkTaskContext } from "@/hooks/useNetworkTask";

/** Probe count above which the scanner warns before starting. */
const LARGE_SCAN_THRESHOLD = 1000;

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
  const [timeoutMs, setTimeoutMs] = useState<number | "">(2000);
  const [concurrency, setConcurrency] = useState<number | "">(100);
  const [results, setResults] = useState<ScanRow[]>([]);
  const [summary, setSummary] = useState<PortScanSummary | null>(null);
  const [warnOpen, setWarnOpen] = useState(false);

  const hostRef = useAutofocusSelect<HTMLInputElement>();

  const timeoutError = validateIntRange(timeoutMs, { min: 1, max: 600_000, label: "Timeout" });
  const concurrencyError = validateIntRange(concurrency, {
    min: 1,
    max: 2000,
    label: "Concurrency",
  });
  const canRun = !!host.trim() && !timeoutError && !concurrencyError;

  // Warn before a very large scan. The estimate factors in the CIDR host-count
  // as well as the port count, so a small port list over a wide block still
  // trips the warning. Recomputed only when the host/ports inputs change.
  const probeEstimate = useMemo(() => estimateScanProbes(host, ports), [host, ports]);

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
      () => networkPortScan(host, ports, Number(timeoutMs), Number(concurrency)),
      [host, ports, timeoutMs, concurrency]
    ),
    cancel: networkPortScanCancel,
    onReset: useCallback(() => {
      setResults([]);
      setSummary(null);
    }, []),
    subscribe,
  });

  const handleRun = useCallback(async () => {
    if (!canRun) return;
    if (probeEstimate > LARGE_SCAN_THRESHOLD) {
      setWarnOpen(true);
      return;
    }
    await run();
  }, [canRun, probeEstimate, run]);

  const handleConfirmLargeScan = useCallback(async () => {
    setWarnOpen(false);
    await run();
  }, [run]);

  // Enter submits the form; ignore while running or when the form is invalid
  // (handleRun re-checks and may open the large-scan confirmation instead).
  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (status === "running" || !canRun) return;
      void handleRun();
    },
    [status, canRun, handleRun]
  );

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
    <form className="network-panel" data-testid="port-scanner-panel" onSubmit={handleSubmit}>
      <div className="network-panel__header">
        <span className="network-panel__title">Port Scanner</span>
        <div className="network-panel__actions">
          {status === "running" ? (
            <Button variant="danger" size="sm" icon={<StopCircle size={14} />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={<Play size={14} />}
              disabled={!canRun}
              data-testid="port-scanner-run"
            >
              Run
            </Button>
          )}
        </div>
      </div>

      <div className="network-panel__form">
        <label className="network-panel__field">
          <span>Host / CIDR</span>
          <input
            ref={hostRef}
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
        <NetworkNumberField
          label="Timeout (ms)"
          value={timeoutMs}
          onChange={setTimeoutMs}
          error={timeoutError}
          small
          data-testid="port-scanner-timeout"
        />
        <NetworkNumberField
          label="Concurrency"
          value={concurrency}
          onChange={setConcurrency}
          error={concurrencyError}
          small
          data-testid="port-scanner-concurrency"
        />
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      <DiagnosticResultsTable
        columns={columns}
        rows={formattedRows}
        rowTestIdPrefix="port-scanner-result"
        footerTestId="port-scanner-footer"
        footer={
          summary
            ? `Scanned ${summary.total} ports in ${(summary.elapsedMs / 1000).toFixed(1)}s — ${summary.open} open, ${summary.closed} closed, ${summary.filtered} filtered${status === "canceled" ? " (scan canceled)" : ""}`
            : status === "running"
              ? `Scanning… ${results.length} ports checked`
              : null
        }
      />

      <Modal
        open={warnOpen}
        onOpenChange={setWarnOpen}
        title="Large scan"
        description="Confirm before starting a scan that may take a while."
        data-testid="port-scan-warn-modal"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setWarnOpen(false)}
              data-testid="port-scan-warn-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirmLargeScan}
              data-testid="port-scan-warn-confirm"
            >
              Start scan
            </Button>
          </>
        }
      >
        This scan will probe about {probeEstimate.toLocaleString()} host/port combinations and may
        take several minutes. Continue?
      </Modal>
    </form>
  );
}
