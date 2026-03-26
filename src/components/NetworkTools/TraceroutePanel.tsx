import { useState, useEffect, useCallback, useRef } from "react";
import { Play, StopCircle } from "lucide-react";
import {
  networkTraceroute,
  networkTracerouteCancel,
  onTracerouteHop,
  onTracerouteComplete,
} from "@/services/networkApi";
import type { TracerouteHop, DiagnosticStatus } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { frontendLog } from "@/utils/frontendLog";

interface TraceroutePanelProps {
  prefillHost?: string;
}

/** Traceroute diagnostic tab content. */
export function TraceroutePanel({ prefillHost }: TraceroutePanelProps) {
  const [host, setHost] = useState(prefillHost ?? "");
  const [maxHops, setMaxHops] = useState(30);
  const [status, setStatus] = useState<DiagnosticStatus>("idle");
  const [hops, setHops] = useState<TracerouteHop[]>([]);
  const [error, setError] = useState<string | null>(null);

  const taskIdRef = useRef<string | null>(null);

  const handleRun = useCallback(async () => {
    if (!host.trim()) return;
    setStatus("running");
    setHops([]);
    setError(null);

    try {
      const taskId = await networkTraceroute(host, maxHops);
      taskIdRef.current = taskId;

      const unlistenHop = await onTracerouteHop((payload) => {
        if (payload.taskId !== taskId) return;
        setHops((prev) => [...prev, payload.hop]);
      });

      const unlistenComplete = await onTracerouteComplete((payload) => {
        if (payload.taskId !== taskId) return;
        setStatus("completed");
        unlistenHop();
        unlistenComplete();
        taskIdRef.current = null;
      });
    } catch (err) {
      setError(String(err));
      setStatus("error");
      frontendLog("traceroute", `Traceroute failed: ${err}`);
    }
  }, [host, maxHops]);

  const handleStop = useCallback(async () => {
    if (!taskIdRef.current) return;
    try {
      await networkTracerouteCancel(taskIdRef.current);
    } catch (err) {
      frontendLog("traceroute", `Cancel failed: ${err}`);
    }
    setStatus("canceled");
    taskIdRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (taskIdRef.current) {
        void networkTracerouteCancel(taskIdRef.current).catch(() => {});
      }
    };
  }, []);

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
    <div className="network-panel" data-testid="traceroute-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">Traceroute</span>
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
              data-testid="traceroute-run"
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
            placeholder="example.com"
            data-testid="traceroute-host"
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Max Hops</span>
          <input
            className="network-panel__input"
            type="number"
            value={maxHops}
            onChange={(e) => setMaxHops(Number(e.target.value))}
          />
        </label>
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
    </div>
  );
}
