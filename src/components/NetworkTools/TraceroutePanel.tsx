import { useState, useCallback } from "react";
import { Play, StopCircle } from "lucide-react";
import { Button, Field, Input, NumberInput } from "@/components/ui";
import {
  networkTraceroute,
  networkTracerouteCancel,
  onTracerouteHop,
  onTracerouteComplete,
  onTracerouteError,
} from "@/services/networkApi";
import type { TracerouteHop } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { validateHost, validateIntRange } from "@/utils/fieldValidation";
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
  const hostError = validateHost(host);
  const canRun = !hostError && !maxHopsError;

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

  // Average the last hop's *valid* round-trips only. When the final hop never
  // answered (all `null`) there is no meaningful average — keep it `null` so the
  // footer omits it rather than rendering "avg NaNms" (or a misleading 0ms).
  const lastHop = hops[hops.length - 1];
  const lastValidRtts = lastHop?.rttMs.filter((r): r is number => r != null) ?? [];
  const avgRtt =
    lastValidRtts.length > 0
      ? lastValidRtts.reduce((a, b) => a + b, 0) / lastValidRtts.length
      : null;

  return (
    <form className="network-panel" data-testid="traceroute-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">Traceroute</span>
        <div className="network-panel__actions">
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
              onClick={run}
              data-testid="traceroute-run"
            >
              Start
            </Button>
          )}
        </div>
      </div>

      <div className="network-panel__form">
        <Field
          className="network-panel__field"
          label="Host"
          htmlFor="traceroute-host"
          error={hostError ?? undefined}
        >
          <Input
            ref={hostRef}
            id="traceroute-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com"
            error={!!hostError}
            data-testid="traceroute-host"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Max Hops"
          htmlFor="traceroute-max-hops"
          error={maxHopsError ?? undefined}
        >
          <NumberInput
            id="traceroute-max-hops"
            value={maxHops}
            onValueChange={setMaxHops}
            error={!!maxHopsError}
            data-testid="traceroute-max-hops"
          />
        </Field>
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      <DiagnosticResultsTable
        columns={columns}
        rows={formattedRows}
        footerTestId="traceroute-footer"
        footer={
          status === "completed"
            ? `Trace complete: ${hops.length} hops${avgRtt != null ? `, avg ${avgRtt.toFixed(0)}ms` : ""}`
            : status === "canceled"
              ? `Trace canceled: ${hops.length} hops`
              : status === "running"
                ? `Tracing… hop ${hops.length}`
                : null
        }
      />
    </form>
  );
}
