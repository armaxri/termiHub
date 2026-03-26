import { useState, useEffect, useCallback, useRef } from "react";
import { Play, StopCircle } from "lucide-react";
import {
  networkPingStart,
  networkPingStop,
  onPingResult,
  onPingComplete,
} from "@/services/networkApi";
import type { PingResult, PingStats, DiagnosticStatus } from "@/types/network";
import { LatencyChart } from "./LatencyChart";
import { frontendLog } from "@/utils/frontendLog";

interface PingPanelProps {
  prefillHost?: string;
}

const MAX_CHART_POINTS = 120; // 2 minutes at 1s interval

/** Ping diagnostic tab content. */
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

  const cleanup = useCallback(() => {
    unlistenResultRef.current?.();
    unlistenCompleteRef.current?.();
    unlistenResultRef.current = null;
    unlistenCompleteRef.current = null;
  }, []);

  const handleStart = useCallback(async () => {
    if (!host.trim()) return;

    setStatus("running");
    setResults([]);
    setStats(null);
    setTcpFallback(false);
    setError(null);
    cleanup();

    try {
      const taskId = await networkPingStart(host, intervalMs, count !== "" ? count : undefined);
      taskIdRef.current = taskId;

      const unlistenResult = await onPingResult((payload) => {
        if (payload.taskId !== taskId) return;
        const result = payload.result;
        if (result.tcpFallback) setTcpFallback(true);
        setResults((prev) =>
          prev.length >= MAX_CHART_POINTS ? [...prev.slice(1), result] : [...prev, result]
        );
      });
      unlistenResultRef.current = unlistenResult;

      const unlistenComplete = await onPingComplete((payload) => {
        if (payload.taskId !== taskId) return;
        setStats(payload.stats);
        setStatus(payload.canceled ? "canceled" : "completed");
        cleanup();
        taskIdRef.current = null;
      });
      unlistenCompleteRef.current = unlistenComplete;
    } catch (err) {
      setError(String(err));
      setStatus("error");
      frontendLog("ping_panel", `Ping failed: ${err}`);
    }
  }, [host, intervalMs, count, cleanup]);

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
            <button className="network-panel__btn network-panel__btn--stop" onClick={handleStop}>
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
        <div className="network-panel__chart-section">
          <span className="network-panel__chart-title">Latency Graph</span>
          <LatencyChart points={latencyPoints} />
        </div>
      )}

      {(stats || status === "running") && (
        <div className="network-panel__stats">
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
