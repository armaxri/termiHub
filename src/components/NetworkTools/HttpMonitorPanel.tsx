import { useState, useCallback, useEffect, useRef } from "react";
import { Play, StopCircle, RefreshCw } from "lucide-react";
import {
  networkHttpMonitorStart,
  networkHttpMonitorStop,
  networkHttpMonitorList,
  onHttpMonitorCheck,
} from "@/services/networkApi";
import type { HttpMonitorState, HttpCheckResult } from "@/types/network";
import { LatencyChart } from "./LatencyChart";
import { frontendLog } from "@/utils/frontendLog";

const MAX_HISTORY = 120;

/** HTTP Monitor diagnostic tab content. */
export function HttpMonitorPanel() {
  const [url, setUrl] = useState("https://");
  // UI uses seconds; API takes milliseconds
  const [intervalSecs, setIntervalSecs] = useState(30);
  const [method, setMethod] = useState("GET");
  const [expectedStatus, setExpectedStatus] = useState<number | "">(200);
  const [timeoutSecs, setTimeoutSecs] = useState(10);
  const [monitors, setMonitors] = useState<HttpMonitorState[]>([]);
  const [history, setHistory] = useState<HttpCheckResult[]>([]);
  const [activeMonitorId, setActiveMonitorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The check listener filters by the active monitor id; a ref mirrors the state
  // so the callback (registered before start) always reads the current id without
  // re-subscribing. `unlistenCheckRef` lets us tear the listener down on
  // stop/unmount/restart.
  const activeMonitorIdRef = useRef<string | null>(null);
  const unlistenCheckRef = useRef<(() => void) | null>(null);

  const loadMonitors = useCallback(async () => {
    try {
      const list = await networkHttpMonitorList();
      setMonitors(list);
    } catch (err) {
      frontendLog("http_monitor", `Failed to list monitors: ${err}`);
    }
  }, []);

  useEffect(() => {
    void loadMonitors();
  }, [loadMonitors]);

  const stopListening = useCallback(() => {
    unlistenCheckRef.current?.();
    unlistenCheckRef.current = null;
  }, []);

  const clearActiveMonitor = useCallback(() => {
    activeMonitorIdRef.current = null;
    setActiveMonitorId(null);
    stopListening();
  }, [stopListening]);

  const handleStart = useCallback(async () => {
    if (!url.trim()) return;
    setError(null);
    setHistory([]);
    stopListening();
    try {
      // Register the check listener BEFORE starting. The backend runs an
      // immediate first check (run_monitor calls check_once before the first
      // interval sleep) and emits it as soon as the spawned task runs, so a
      // listener attached only after start — as the old activeMonitorId-gated
      // effect did — could miss that first check and leave the panel blank for
      // up to one interval (#1002). The id is set synchronously the moment start
      // resolves, before any emitted event can be processed, so filtering by it
      // never drops the first check.
      unlistenCheckRef.current = await onHttpMonitorCheck((result: HttpCheckResult) => {
        if (result.monitorId !== activeMonitorIdRef.current) return;
        setHistory((prev) =>
          prev.length >= MAX_HISTORY ? [...prev.slice(1), result] : [...prev, result]
        );
      });

      const monitorId = await networkHttpMonitorStart(
        url.trim(),
        intervalSecs * 1000,
        method,
        expectedStatus !== "" ? expectedStatus : undefined,
        timeoutSecs * 1000
      );
      activeMonitorIdRef.current = monitorId;
      setActiveMonitorId(monitorId);
      await loadMonitors();
    } catch (err) {
      stopListening();
      setError(String(err));
      frontendLog("http_monitor", `Start failed: ${err}`);
    }
  }, [url, intervalSecs, method, expectedStatus, timeoutSecs, loadMonitors, stopListening]);

  const handleStop = useCallback(async () => {
    if (!activeMonitorIdRef.current) return;
    try {
      await networkHttpMonitorStop(activeMonitorIdRef.current);
      clearActiveMonitor();
      await loadMonitors();
    } catch (err) {
      setError(String(err));
    }
  }, [loadMonitors, clearActiveMonitor]);

  const handleStopMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorStop(id);
        if (id === activeMonitorIdRef.current) clearActiveMonitor();
        await loadMonitors();
      } catch (err) {
        setError(String(err));
      }
    },
    [loadMonitors, clearActiveMonitor]
  );

  // Tear the listener down on unmount.
  useEffect(() => stopListening, [stopListening]);

  const latencyPoints = history.map((r) => r.latencyMs ?? null);
  // Chart x axis uses the active monitor's real check interval (not the form field).
  const activeIntervalMs = monitors.find((m) => m.config.id === activeMonitorId)?.config.intervalMs;
  const successCount = history.filter((r) => r.ok).length;
  const lossPercent =
    history.length > 0 ? ((history.length - successCount) / history.length) * 100 : 0;
  const avgMs =
    history.length > 0
      ? history.filter((r) => r.latencyMs != null).reduce((a, r) => a + (r.latencyMs ?? 0), 0) /
        Math.max(history.filter((r) => r.latencyMs != null).length, 1)
      : null;

  return (
    <div className="network-panel" data-testid="http-monitor-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">HTTP Monitor</span>
        <div className="network-panel__actions">
          <button
            className="network-panel__btn network-panel__btn--run"
            onClick={loadMonitors}
            title="Refresh monitor list"
          >
            <RefreshCw size={14} />
          </button>
          {activeMonitorId ? (
            <button
              className="network-panel__btn network-panel__btn--stop"
              onClick={handleStop}
              data-testid="http-monitor-stop"
            >
              <StopCircle size={14} />
              Stop
            </button>
          ) : (
            <button
              className="network-panel__btn network-panel__btn--run"
              onClick={handleStart}
              disabled={!url.trim() || url === "https://"}
              data-testid="http-monitor-start"
            >
              <Play size={14} />
              Start
            </button>
          )}
        </div>
      </div>

      <div className="network-panel__form">
        <label className="network-panel__field">
          <span>URL</span>
          <input
            className="network-panel__input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            data-testid="http-monitor-url"
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Method</span>
          <select
            className="network-panel__select"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            <option>GET</option>
            <option>HEAD</option>
            <option>POST</option>
          </select>
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Interval (s)</span>
          <input
            className="network-panel__input"
            type="number"
            value={intervalSecs}
            onChange={(e) => setIntervalSecs(Number(e.target.value))}
            min={5}
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Expected status</span>
          <input
            className="network-panel__input"
            type="number"
            value={expectedStatus}
            onChange={(e) => setExpectedStatus(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder="200"
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Timeout (s)</span>
          <input
            className="network-panel__input"
            type="number"
            value={timeoutSecs}
            onChange={(e) => setTimeoutSecs(Number(e.target.value))}
            min={1}
          />
        </label>
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      {/* Active monitor stats */}
      {activeMonitorId && history.length > 0 && (
        <>
          <div className="network-panel__chart-section" data-testid="http-monitor-chart">
            <span className="network-panel__chart-title">Response Time</span>
            <LatencyChart points={latencyPoints} intervalMs={activeIntervalMs} />
          </div>
          <div className="network-panel__stats">
            <span>
              Checks: {history.length} · Success: {successCount} · Loss: {lossPercent.toFixed(1)}%
            </span>
            {avgMs != null && <span>Avg response: {avgMs.toFixed(0)}ms</span>}
            <span>
              Last:{" "}
              {history[history.length - 1]?.ok ? (
                <span className="network-panel__ok">
                  {history[history.length - 1].statusCode} OK
                </span>
              ) : (
                <span className="network-panel__fail">
                  {history[history.length - 1].error ?? "Failed"}
                </span>
              )}
            </span>
          </div>

          {/* Recent checks table */}
          <div className="network-panel__section-title">Recent Checks</div>
          <div className="network-panel__table-wrapper" data-testid="http-monitor-history">
            <table className="network-panel__table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Response</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {[...history]
                  .reverse()
                  .slice(0, 20)
                  .map((r, i) => (
                    <tr
                      key={i}
                      className={r.ok ? "" : "network-panel__row--error"}
                      data-testid={`http-monitor-entry-${i}`}
                    >
                      <td>{new Date(r.timestampMs).toLocaleTimeString()}</td>
                      <td>{r.statusCode ?? "—"}</td>
                      <td>{r.latencyMs != null ? `${r.latencyMs}ms` : "—"}</td>
                      <td>{r.ok ? "OK" : (r.error ?? "Failed")}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* All running monitors */}
      {monitors.length > 0 && (
        <>
          <div className="network-panel__section-title">Running Monitors</div>
          {monitors.map((m) => (
            <div key={m.config.id} className="http-monitor-row">
              <span className="http-monitor-row__url" title={m.config.url}>
                {m.config.url}
              </span>
              <span className="http-monitor-row__meta">
                {m.config.method} · every {m.config.intervalMs / 1000}s
              </span>
              <button
                className="network-panel__icon-btn network-panel__icon-btn--danger"
                onClick={() => handleStopMonitor(m.config.id)}
                title="Stop"
              >
                <StopCircle size={13} />
              </button>
            </div>
          ))}
        </>
      )}

      {monitors.length === 0 && !activeMonitorId && (
        <div className="network-panel__placeholder">
          No running monitors. Enter a URL and click Start.
        </div>
      )}
    </div>
  );
}
