import { useCallback, useMemo, useState } from "react";
import { Play, ServerCog, StopCircle } from "lucide-react";
import { Button, ConfirmDialog, Field, Input, NumberInput } from "@/components/ui";
import { FleetOnboardDialog } from "@/components/Sidebar/FleetOnboardDialog";
import { pingSweepResultsToRows } from "@/services/fleetOnboard";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import {
  networkPingSweep,
  networkPingSweepCancel,
  onSweepResult,
  onSweepComplete,
  onSweepError,
} from "@/services/networkApi";
import type { PingSweepSummary } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { validateHost, validateIntRange } from "@/utils/fieldValidation";
import { countHosts } from "@/utils/scanEstimate";
import { useNetworkTask, type NetworkTaskContext } from "@/hooks/useNetworkTask";
import { useAppStore } from "@/store/appStore";

/** Host count above which the sweep warns before starting. */
const LARGE_SWEEP_THRESHOLD = 1024;

interface PingSweepPanelProps {
  prefillHost?: string;
}

interface SweepRow {
  host: string;
  latencyMs?: number;
  hostname?: string;
}

/**
 * Ping Sweep diagnostic tab content.
 *
 * Enumerates the hosts of a CIDR / IP range and ICMP-pings each concurrently,
 * streaming the responders into a live table. Non-responders are tallied and
 * surfaced in the footer. Mirrors the Port Scanner's range input, large-scan
 * warning, and Stop wiring.
 */
export function PingSweepPanel({ prefillHost }: PingSweepPanelProps) {
  const [host, setHost] = useState(prefillHost ?? "");
  const [timeoutMs, setTimeoutMs] = useState<number | "">(1000);
  const [concurrency, setConcurrency] = useState<number | "">(64);
  const [results, setResults] = useState<SweepRow[]>([]);
  const [summary, setSummary] = useState<PingSweepSummary | null>(null);
  const [warnOpen, setWarnOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  // Local, deferred opt-out state — committed to settings only on confirm,
  // discarded on cancel (honours the ConfirmDialog checkbox contract).
  const [dontWarnAgain, setDontWarnAgain] = useState(false);

  // Persisted "warn before a large sweep" preference. Defaults to true when
  // unset; the dialog's opt-out flips it off, re-enabled from General settings.
  const warnLargeSweep = useAppStore((s) => s.settings.warnLargePingSweep);
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
  const canRun = !hostError && !timeoutError && !concurrencyError;

  // Number of hosts the range expands to; drives the large-sweep warning.
  // Recomputed only when the host input changes.
  const hostEstimate = useMemo(() => countHosts(host), [host]);

  const subscribe = useCallback(async ({ matchesTask, register, finish }: NetworkTaskContext) => {
    register(
      await onSweepResult((p) => {
        if (!matchesTask(p.taskId)) return;
        setResults((prev) => [
          ...prev,
          { host: p.host, latencyMs: p.latencyMs, hostname: p.hostname },
        ]);
      })
    );
    register(
      await onSweepComplete((p) => {
        if (!matchesTask(p.taskId)) return;
        setSummary(p.summary);
        finish("completed");
      })
    );
    register(
      await onSweepError((p) => {
        if (!matchesTask(p.taskId)) return;
        finish("error", p.error);
      })
    );
  }, []);

  const { status, error, run, stop } = useNetworkTask({
    logScope: "ping_sweep",
    start: useCallback(
      () => networkPingSweep(host, Number(timeoutMs), Number(concurrency)),
      [host, timeoutMs, concurrency]
    ),
    cancel: networkPingSweepCancel,
    onReset: useCallback(() => {
      setResults([]);
      setSummary(null);
    }, []),
    subscribe,
  });

  const handleRun = useCallback(async () => {
    if (!canRun) return;
    // Skip the warning when the user previously opted out (warnLargePingSweep
    // === false); the sweep then starts directly. Unset defaults to warning.
    if (hostEstimate > LARGE_SWEEP_THRESHOLD && warnLargeSweep !== false) {
      setWarnOpen(true);
      return;
    }
    await run();
  }, [canRun, hostEstimate, warnLargeSweep, run]);

  const handleConfirmLargeSweep = useCallback(async () => {
    // Deferred opt-out: persist only when confirmed with the box ticked.
    if (dontWarnAgain) {
      void updateSettings({ ...settings, warnLargePingSweep: false });
    }
    setDontWarnAgain(false);
    setWarnOpen(false);
    await run();
  }, [dontWarnAgain, settings, updateSettings, run]);

  const handleCancelLargeSweep = useCallback(() => {
    setDontWarnAgain(false);
    setWarnOpen(false);
  }, []);

  const columns = [
    { key: "host", label: "Host" },
    { key: "status", label: "Status" },
    { key: "latencyMs", label: "RTT" },
    { key: "hostname", label: "Name" },
  ];

  const formattedRows = results.map((r) => ({
    host: r.host,
    status: "up",
    latencyMs: r.latencyMs != null ? `${r.latencyMs}ms` : "—",
    hostname: r.hostname ?? "—",
  }));

  return (
    <form className="network-panel" data-testid="ping-sweep-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">Ping Sweep</span>
        <div className="network-panel__actions">
          {results.length > 0 && status !== "running" && (
            <Button
              variant="secondary"
              size="sm"
              icon={<ServerCog size={14} />}
              onClick={() => setOnboardOpen(true)}
              data-testid="ping-sweep-onboard"
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
              data-testid="ping-sweep-stop"
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
              data-testid="ping-sweep-run"
            >
              Start
            </Button>
          )}
        </div>
      </div>

      <div className="network-panel__form">
        <Field
          className="network-panel__field"
          label="Subnet / Range"
          htmlFor="ping-sweep-host"
          error={hostError ?? undefined}
        >
          <Input
            ref={hostRef}
            id="ping-sweep-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.0/24, 10.0.0.1-10.0.0.5"
            error={!!hostError}
            data-testid="ping-sweep-host"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Timeout (ms)"
          htmlFor="ping-sweep-timeout"
          error={timeoutError ?? undefined}
        >
          <NumberInput
            id="ping-sweep-timeout"
            value={timeoutMs}
            onValueChange={setTimeoutMs}
            error={!!timeoutError}
            data-testid="ping-sweep-timeout"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Concurrency"
          htmlFor="ping-sweep-concurrency"
          error={concurrencyError ?? undefined}
        >
          <NumberInput
            id="ping-sweep-concurrency"
            value={concurrency}
            onValueChange={setConcurrency}
            error={!!concurrencyError}
            data-testid="ping-sweep-concurrency"
          />
        </Field>
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      <DiagnosticResultsTable
        columns={columns}
        rows={formattedRows}
        rowTestIdPrefix="ping-sweep-result"
        footerTestId="ping-sweep-footer"
        footer={
          summary
            ? `Swept ${summary.total} host${summary.total === 1 ? "" : "s"} in ${(
                summary.elapsedMs / 1000
              ).toFixed(1)}s — ${summary.up} up, ${summary.down} down${
                status === "canceled" ? " (sweep canceled)" : ""
              }`
            : status === "running"
              ? `Sweeping… ${results.length} up so far`
              : null
        }
      />

      <ConfirmDialog
        open={warnOpen}
        title="Large ping sweep"
        description="Confirm before starting a sweep that may take a while."
        message={`This sweep will ping about ${hostEstimate.toLocaleString()} hosts and may take a while. Continue?`}
        confirmLabel="Start sweep"
        confirmVariant="primary"
        testIdBase="ping-sweep-warn"
        data-testid="ping-sweep-warn-modal"
        dontAskAgain={{
          checked: dontWarnAgain,
          onChange: setDontWarnAgain,
          label: "Don't warn again",
        }}
        onConfirm={handleConfirmLargeSweep}
        onCancel={handleCancelLargeSweep}
      />

      <FleetOnboardDialog
        open={onboardOpen}
        onOpenChange={setOnboardOpen}
        rows={pingSweepResultsToRows(results)}
        sourceLabel="the ping sweep results"
      />
    </form>
  );
}
