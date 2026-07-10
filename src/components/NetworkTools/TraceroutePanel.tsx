import { useState, useCallback, type FormEvent } from "react";
import { Play, StopCircle } from "lucide-react";
import { Button } from "@/components/ui";
import {
  networkTraceroute,
  networkTracerouteCancel,
  onTracerouteHop,
  onTracerouteComplete,
  onTracerouteError,
} from "@/services/networkApi";
import type { TracerouteHop } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { NetworkNumberField } from "./NetworkNumberField";
import { validateIntRange } from "@/utils/fieldValidation";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import { useNetworkTask, type NetworkTaskContext } from "@/hooks/useNetworkTask";

interface TraceroutePanelProps {
  prefillHost?: string;
}

/** Traceroute diagnostic tab content. */
export function TraceroutePanel({ prefillHost }: TraceroutePanelProps) {
  const [host, setHost] = useState(prefillHost ?? "");
  const [maxHops, setMaxHops] = useState<number | "">(30);
  const [hops, setHops] = useState<TracerouteHop[]>([]);

  const hostRef = useAutofocusSelect<HTMLInputElement>();

  const maxHopsError = validateIntRange(maxHops, { min: 1, max: 255, label: "Max hops" });
  const canRun = !!host.trim() && !maxHopsError;

  const subscribe = useCallback(async ({ matchesTask, register, finish }: NetworkTaskContext) => {
    register(
      await onTracerouteHop((p) => {
        if (!matchesTask(p.taskId)) return;
        setHops((prev) => [...prev, p.hop]);
      })
    );
    register(
      await onTracerouteComplete((p) => {
        if (!matchesTask(p.taskId)) return;
        finish("completed");
      })
    );
    register(
      await onTracerouteError((p) => {
        if (!matchesTask(p.taskId)) return;
        finish("error", p.error);
      })
    );
  }, []);

  const { status, error, run, stop } = useNetworkTask({
    logScope: "traceroute",
    start: useCallback(() => networkTraceroute(host, Number(maxHops)), [host, maxHops]),
    cancel: networkTracerouteCancel,
    onReset: useCallback(() => setHops([]), []),
    subscribe,
  });

  // Enter submits the form; ignore while running or when the form is invalid.
  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (status === "running" || !canRun) return;
      void run();
    },
    [status, canRun, run]
  );

  const columns = [
    { key: "hop", label: "Hop" },
    { key: "ip", label: "Host" },
    { key: "rtt1", label: "RTT 1" },
    { key: "rtt2", label: "RTT 2" },
    { key: "rtt3", label: "RTT 3" },
  ];

  const formattedRows = hops.map((h) => ({
    hop: h.hop,
    ip: h.ip ?? "* * *",
    rtt1: h.rttMs[0] != null ? `${h.rttMs[0].toFixed(1)}ms` : "—",
    rtt2: h.rttMs[1] != null ? `${h.rttMs[1].toFixed(1)}ms` : "—",
    rtt3: h.rttMs[2] != null ? `${h.rttMs[2].toFixed(1)}ms` : "—",
  }));

  const lastHop = hops[hops.length - 1];
  const avgRtt =
    lastHop?.rttMs.filter((r): r is number => r != null).reduce((a, b) => a + b, 0) /
    (lastHop?.rttMs.filter((r): r is number => r != null).length || 1);

  return (
    <form className="network-panel" data-testid="traceroute-panel" onSubmit={handleSubmit}>
      <div className="network-panel__header">
        <span className="network-panel__title">Traceroute</span>
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
              data-testid="traceroute-run"
            >
              Run
            </Button>
          )}
        </div>
      </div>

      <div className="network-panel__form">
        <label className="network-panel__field">
          <span>Host</span>
          <input
            ref={hostRef}
            className="network-panel__input"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com"
            data-testid="traceroute-host"
          />
        </label>
        <NetworkNumberField
          label="Max Hops"
          value={maxHops}
          onChange={setMaxHops}
          error={maxHopsError}
          small
          data-testid="traceroute-max-hops"
        />
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      <DiagnosticResultsTable
        columns={columns}
        rows={formattedRows}
        footer={
          status === "completed"
            ? `Trace complete: ${hops.length} hops, avg ${avgRtt.toFixed(0)}ms`
            : status === "running"
              ? `Tracing… hop ${hops.length}`
              : null
        }
      />
    </form>
  );
}
