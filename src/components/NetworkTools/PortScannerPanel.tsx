import { useState, useCallback, useMemo } from "react";
import { Play, ServerCog, StopCircle } from "lucide-react";
import { Button, ConfirmDialog, Field, Input, NumberInput } from "@/components/ui";
import { FleetOnboardDialog } from "@/components/Sidebar/FleetOnboardDialog";
import { portScanResultsToRows } from "@/services/fleetOnboard";
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
import { validateHost, validateIntRange } from "@/utils/fieldValidation";
import { estimateScanProbes } from "@/utils/scanEstimate";
import { useNetworkTask, type NetworkTaskContext } from "@/hooks/useNetworkTask";
import { useAppStore } from "@/store/appStore";

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
  // Local, deferred opt-out state — committed to settings only on confirm,
  // discarded on cancel (honours the ConfirmDialog checkbox contract).
  const [dontWarnAgain, setDontWarnAgain] = useState(false);

  // Persisted "warn before a large scan" preference. Defaults to true when
  // unset; the dialog's opt-out flips it off, re-enabled from General settings.
  const warnLargeScan = useAppStore((s) => s.settings.warnLargePortScan);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const hostRef = useAutofocusSelect<HTMLInputElement>();

  const timeoutError = validateIntRange(timeoutMs, { min: 1, max: 600_000, label: "Timeout" });
  const concurrencyError = validateIntRange(concurrency, {
    min: 1,
    max: 2000,
    label: "Concurrency",
  });
  const hostError = validateHost(host);
  const portsError = ports.trim() ? null : "Enter at least one port";
  const canRun = !hostError && !portsError && !timeoutError && !concurrencyError;

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
    // Skip the warning when the user previously opted out (warnLargePortScan
    // === false); the scan then starts directly. Unset defaults to warning.
    if (probeEstimate > LARGE_SCAN_THRESHOLD && warnLargeScan !== false) {
      setWarnOpen(true);
      return;
    }
    await run();
  }, [canRun, probeEstimate, warnLargeScan, run]);

  const handleConfirmLargeScan = useCallback(async () => {
    // Deferred opt-out: persist only when confirmed with the box ticked.
    if (dontWarnAgain) {
      void updateSettings({ ...settings, warnLargePortScan: false });
    }
    setDontWarnAgain(false);
    setWarnOpen(false);
    await run();
  }, [dontWarnAgain, settings, updateSettings, run]);

  const handleCancelLargeScan = useCallback(() => {
    setDontWarnAgain(false);
    setWarnOpen(false);
  }, []);

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

  // Live open-port tally so the running footer surfaces progress, not just the
  // number of ports checked.
  const liveOpen = useMemo(() => results.filter((r) => r.state === "open").length, [results]);
  const [onboardOpen, setOnboardOpen] = useState(false);

  return (
    <form className="network-panel" data-testid="port-scanner-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">Port Scanner</span>
        <div className="network-panel__actions">
          {liveOpen > 0 && status !== "running" && (
            <Button
              variant="secondary"
              size="sm"
              icon={<ServerCog size={14} />}
              onClick={() => setOnboardOpen(true)}
              data-testid="port-scanner-onboard"
            >
              Add as connections
            </Button>
          )}
          {status === "running" ? (
            <Button
              variant="danger"
              size="sm"
              icon={<StopCircle size={14} />}
              pendingLabel="Stopping…"
              errorToast={false}
              onClick={stop}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={<Play size={14} />}
              pendingLabel="Starting…"
              errorToast={false}
              type="submit"
              disabled={!canRun}
              onClick={handleRun}
              data-testid="port-scanner-run"
            >
              Start
            </Button>
          )}
        </div>
      </div>

      <div className="network-panel__form">
        <Field
          className="network-panel__field"
          label="Host / CIDR"
          htmlFor="port-scanner-host"
          error={hostError ?? undefined}
        >
          <Input
            ref={hostRef}
            id="port-scanner-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.1, 10.0.0.0/24, example.com"
            error={!!hostError}
            data-testid="port-scanner-host"
          />
        </Field>
        <Field
          className="network-panel__field"
          label="Ports"
          htmlFor="port-scanner-ports"
          error={portsError ?? undefined}
        >
          <Input
            id="port-scanner-ports"
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
            placeholder="22,80,443,8080-8090"
            error={!!portsError}
            data-testid="port-scanner-ports"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Timeout (ms)"
          htmlFor="port-scanner-timeout"
          error={timeoutError ?? undefined}
        >
          <NumberInput
            id="port-scanner-timeout"
            value={timeoutMs}
            onValueChange={setTimeoutMs}
            error={!!timeoutError}
            data-testid="port-scanner-timeout"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Concurrency"
          htmlFor="port-scanner-concurrency"
          error={concurrencyError ?? undefined}
        >
          <NumberInput
            id="port-scanner-concurrency"
            value={concurrency}
            onValueChange={setConcurrency}
            error={!!concurrencyError}
            data-testid="port-scanner-concurrency"
          />
        </Field>
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
              ? `Scanning… ${results.length} checked, ${liveOpen} open`
              : null
        }
      />

      <ConfirmDialog
        open={warnOpen}
        title="Large scan"
        variant="warn"
        description="Confirm before starting a scan that may take a while."
        message={`This scan will probe about ${probeEstimate.toLocaleString()} host/port combinations and may take several minutes. Continue?`}
        confirmLabel="Start scan"
        confirmVariant="primary"
        testIdBase="port-scan-warn"
        data-testid="port-scan-warn-modal"
        dontAskAgain={{
          checked: dontWarnAgain,
          onChange: setDontWarnAgain,
          label: "Don't warn again",
        }}
        onConfirm={handleConfirmLargeScan}
        onCancel={handleCancelLargeScan}
      />

      <FleetOnboardDialog
        open={onboardOpen}
        onOpenChange={setOnboardOpen}
        rows={portScanResultsToRows(results)}
        sourceLabel="the open ports found"
      />
    </form>
  );
}
