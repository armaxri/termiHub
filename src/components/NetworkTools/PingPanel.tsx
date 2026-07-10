import { useState, useEffect, useCallback, useRef } from "react";
import { Play, StopCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import { useFormSubmit } from "@/hooks/useFormSubmit";
import {
  networkPingStart,
  networkPingStop,
  onPingResult,
  onPingComplete,
  onPingError,
} from "@/services/networkApi";
import type { PingResult, PingStats, DiagnosticStatus } from "@/types/network";
import { LatencyChart } from "./LatencyChart";
import { NetworkNumberField } from "./NetworkNumberField";
import { validateIntRange } from "@/utils/fieldValidation";
import { frontendLog } from "@/utils/frontendLog";

interface PingPanelProps {
  prefillHost?: string;
}

const MAX_CHART_POINTS = 120; // 2 minutes at 1s interval

/**
 * Ping diagnostic tab content.
 *
 * Unlike the Traceroute and Port Scanner panels (which share the
 * `useNetworkTask` hook), Ping keeps its own listener wiring: it must keep
 * listening after the user hits Stop to receive the backend's final
 * `network-ping-complete` event (which carries the closing stats and the
 * `canceled` flag), and it juggles several result streams (results / stats /
 * tcpFallback). The hook's stop tears listeners down immediately, so migrating
 * Ping would drop those final stats.
 */
export function PingPanel({ prefillHost }: PingPanelProps) {
  const [host, setHost] = useState(prefillHost ?? "");
  const [intervalMs, setIntervalMs] = useState<number | "">(1000);
  const [count, setCount] = useState<number | "">(""); // empty = infinite
  const [status, setStatus] = useState<DiagnosticStatus>("idle");
  const [results, setResults] = useState<PingResult[]>([]);
  const [stats, setStats] = useState<PingStats | null>(null);
  const [tcpFallback, setTcpFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hostRef = useAutofocusSelect<HTMLInputElement>();

  const taskIdRef = useRef<string | null>(null);
  const unlistenResultRef = useRef<(() => void) | null>(null);
  const unlistenCompleteRef = useRef<(() => void) | null>(null);
  const unlistenErrorRef = useRef<(() => void) | null>(null);

  const cleanup = useCallback(() => {
    unlistenResultRef.current?.();
    unlistenCompleteRef.current?.();
    unlistenErrorRef.current?.();
    unlistenResultRef.current = null;
    unlistenCompleteRef.current = null;
    unlistenErrorRef.current = null;
  }, []);

  // Tear down listeners and forget the active task; the session is over.
  const endSession = useCallback(() => {
    cleanup();
    taskIdRef.current = null;
  }, [cleanup]);

  // Inline validation of the numeric fields. Blocks Start while invalid.
  const intervalError = validateIntRange(intervalMs, {
    min: 1,
    max: 3_600_000,
    label: "Interval",
  });
  const countError = validateIntRange(count, {
    min: 1,
    max: 1_000_000,
    label: "Count",
    allowEmpty: true,
  });
  const canStart = !!host.trim() && !intervalError && !countError;

  const handleStart = useCallback(async () => {
    if (!canStart) return;

    setStatus("running");
    setResults([]);
    setStats(null);
    setTcpFallback(false);
    setError(null);
    endSession();

    // Events are filtered by the active task id. Until networkPingStart returns
    // it is null; accept those events so a result/error the backend emits before
    // the id round-trips back isn't dropped (see the listeners-before-start race).
    const matchesTask = (id: string) => taskIdRef.current === null || id === taskIdRef.current;

    try {
      // Register listeners BEFORE starting so a fast failure (e.g. a cached DNS
      // miss that errors instantly) can't fire network-ping-error before we are
      // listening — which previously left the panel stuck on "running".
      unlistenResultRef.current = await onPingResult((payload) => {
        if (!matchesTask(payload.taskId)) return;
        const result = payload.result;
        if (result.tcpFallback) setTcpFallback(true);
        setResults((prev) =>
          prev.length >= MAX_CHART_POINTS ? [...prev.slice(1), result] : [...prev, result]
        );
      });

      unlistenCompleteRef.current = await onPingComplete((payload) => {
        if (!matchesTask(payload.taskId)) return;
        setStats(payload.stats);
        setStatus(payload.canceled ? "canceled" : "completed");
        endSession();
      });

      // A fatal error (e.g. DNS failure) ends the session backend-side without
      // a complete event; reflect it so the panel doesn't stay stuck "running".
      unlistenErrorRef.current = await onPingError((payload) => {
        if (!matchesTask(payload.taskId)) return;
        setError(payload.error);
        setStatus("error");
        endSession();
      });

      taskIdRef.current = await networkPingStart(
        host,
        Number(intervalMs),
        count !== "" ? Number(count) : undefined
      );
    } catch (err) {
      setError(String(err));
      setStatus("error");
      endSession();
      frontendLog("ping_panel", `Ping failed: ${err}`);
    }
  }, [host, intervalMs, count, canStart, endSession]);

  const handleStop = useCallback(async () => {
    if (!taskIdRef.current) return;
    try {
      await networkPingStop(taskIdRef.current);
    } catch (err) {
      frontendLog("ping_panel", `Stop failed: ${err}`);
    }
    taskIdRef.current = null;
  }, []);

  // Enter submits the form (respects the Start button's disabled state).
  const handleSubmit = useFormSubmit(status !== "running" && canStart, handleStart);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (taskIdRef.current) {
        void networkPingStop(taskIdRef.current).catch(() => {});
      }
      cleanup();
    };
  }, [cleanup]);

  const latencyPoints = results.map((r) => r.latencyMs ?? null);

  return (
    <form className="network-panel" data-testid="ping-panel" onSubmit={handleSubmit}>
      <div className="network-panel__header">
        <span className="network-panel__title">Ping</span>
        <div className="network-panel__actions">
          {status === "running" ? (
            <Button
              variant="danger"
              size="sm"
              icon={<StopCircle size={14} />}
              onClick={handleStop}
              data-testid="ping-stop"
            >
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={<Play size={14} />}
              disabled={!canStart}
              data-testid="ping-start"
            >
              Start
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
            data-testid="ping-host"
          />
        </label>
        <NetworkNumberField
          label="Interval (ms)"
          value={intervalMs}
          onChange={setIntervalMs}
          error={intervalError}
          small
          data-testid="ping-interval"
        />
        <NetworkNumberField
          label="Count (∞ = empty)"
          value={count}
          onChange={setCount}
          error={countError}
          small
          placeholder="∞"
          data-testid="ping-count"
        />
      </div>

      {tcpFallback && (
        <div className="network-panel__info">
          Using TCP ping — ICMP requires elevated privileges
        </div>
      )}
      {error && <div className="network-panel__error">{error}</div>}

      {results.length > 0 && (
        <div className="network-panel__chart-section" data-testid="ping-chart">
          <span className="network-panel__chart-title">Latency Graph</span>
          <LatencyChart
            points={latencyPoints}
            intervalMs={intervalMs === "" ? undefined : intervalMs}
          />
        </div>
      )}

      {(stats || status === "running") && (
        <div className="network-panel__stats" data-testid="ping-stats">
          {stats && (
            <>
              <span>
                Sent: {stats.sent} · Received: {stats.received} · Loss:{" "}
                {stats.lossPercent.toFixed(1)}%
              </span>
              <span>
                RTT: min={stats.minMs.toFixed(0)}ms avg={stats.avgMs.toFixed(0)}ms max=
                {stats.maxMs.toFixed(0)}ms jitter={stats.jitterMs.toFixed(0)}ms
              </span>
            </>
          )}
          {status === "running" && <span>{results.length} replies received…</span>}
        </div>
      )}
    </form>
  );
}
