import { useState, useEffect, useCallback, useRef } from "react";
import { Play, StopCircle } from "lucide-react";
import {
  networkPingStart,
  networkPingStop,
  onPingResult,
  onPingComplete,
  onPingError,
} from "@/services/networkApi";
import type { PingResult, PingStats, DiagnosticStatus } from "@/types/network";
import { LatencyChart } from "./LatencyChart";
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
  const [intervalMs, setIntervalMs] = useState(1000);
  const [count, setCount] = useState<number | "">(""); // empty = infinite
  const [status, setStatus] = useState<DiagnosticStatus>("idle");
  const [results, setResults] = useState<PingResult[]>([]);
  const [stats, setStats] = useState<PingStats | null>(null);
  const [tcpFallback, setTcpFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleStart = useCallback(async () => {
    if (!host.trim()) return;

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
        intervalMs,
        count !== "" ? count : undefined
      );
    } catch (err) {
      setError(String(err));
      setStatus("error");
      endSession();
      frontendLog("ping_panel", `Ping failed: ${err}`);
    }
  }, [host, intervalMs, count, endSession]);

  const handleStop = useCallback(async () => {
    if (!taskIdRef.current) return;
    try {
      await networkPingStop(taskIdRef.current);
    } catch (err) {
      frontendLog("ping_panel", `Stop failed: ${err}`);
    }
    taskIdRef.current = null;
  }, []);

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
    <div className="network-panel" data-testid="ping-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">Ping</span>
        <div className="network-panel__actions">
          {status === "running" ? (
            <button
              className="network-panel__btn network-panel__btn--stop"
              onClick={handleStop}
              data-testid="ping-stop"
            >
              <StopCircle size={14} />
              Stop
            </button>
          ) : (
            <button
              className="network-panel__btn network-panel__btn--run"
              onClick={handleStart}
              disabled={!host.trim()}
              data-testid="ping-start"
            >
              <Play size={14} />
              Start
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
            placeholder="example.com"
            data-testid="ping-host"
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Interval (ms)</span>
          <input
            className="network-panel__input"
            type="number"
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Count (∞ = empty)</span>
          <input
            className="network-panel__input"
            type="number"
            value={count}
            onChange={(e) => setCount(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder="∞"
          />
        </label>
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
          <LatencyChart points={latencyPoints} intervalMs={intervalMs} />
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
    </div>
  );
}
