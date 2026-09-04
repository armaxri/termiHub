import { useState, useCallback, useEffect, useRef } from "react";
import { Play, Pause, StopCircle, Trash2, RefreshCw } from "lucide-react";
import { Button, Tooltip, toast, Field, Input, NumberInput, Select } from "@/components/ui";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import {
  networkHttpMonitorStart,
  networkHttpMonitorStop,
  networkHttpMonitorRemove,
  networkHttpMonitorPause,
  networkHttpMonitorResume,
  networkHttpMonitorList,
  onHttpMonitorCheck,
} from "@/services/networkApi";
import type { HttpMonitorState, HttpCheckResult } from "@/types/network";
import { RunLocationSelect } from "@/components/RunLocationSelect";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useRunLocationStore } from "@/store/runLocationStore";
import { THIS_COMPUTER, isAgentHost, type RunLocation } from "@/utils/runLocation";
import { LatencyChart } from "./LatencyChart";
import { isValidHttpUrl, validateIntRange } from "@/utils/fieldValidation";
import { frontendLog } from "@/utils/frontendLog";

const MAX_HISTORY = 120;

/** HTTP methods offered by the monitor's Method dropdown. */
const HTTP_METHOD_OPTIONS = [
  { value: "GET", label: "GET" },
  { value: "HEAD", label: "HEAD" },
  { value: "POST", label: "POST" },
];

/**
 * HTTP Monitor diagnostic tab content.
 *
 * Unlike the Traceroute and Port Scanner panels (which share the
 * `useNetworkTask` hook), the monitor keeps its own listener wiring: monitors
 * are long-lived and the active one's check listener must outlive individual
 * start/stop cycles and a perpetual monitor list, whereas the hook tears its
 * listener down on stop. As with Ping, the listener is registered *before* the
 * start command so the backend's immediate first check is never missed (#1002).
 */
export function HttpMonitorPanel() {
  const [url, setUrl] = useState("https://");
  // UI uses seconds; API takes milliseconds
  const [intervalSecs, setIntervalSecs] = useState<number | "">(30);
  const [method, setMethod] = useState("GET");
  const [expectedStatus, setExpectedStatus] = useState<number | "">(200);
  const [timeoutSecs, setTimeoutSecs] = useState<number | "">(10);
  const [monitors, setMonitors] = useState<HttpMonitorState[]>([]);
  const [history, setHistory] = useState<HttpCheckResult[]>([]);
  const [activeMonitorId, setActiveMonitorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where the next monitor should run — This computer (default) or an agent,
  // which probes the target from its own vantage and streams the checks back
  // (#2592). Session-only form state; the chosen value is recorded per monitor
  // id in the run-location store once the monitor is created.
  const [runLocation, setRunLocation] = useState<RunLocation>(THIS_COMPUTER);
  const { remoteAgents: agents } = useProjectedAgents();
  const monitorLocations = useRunLocationStore((s) => s.monitorLocations);
  const setMonitorLocation = useRunLocationStore((s) => s.setMonitorLocation);

  const urlRef = useAutofocusSelect<HTMLInputElement>();

  // The check listener filters by the active monitor id; a ref mirrors the state
  // so the callback (registered before start) always reads the current id without
  // re-subscribing. `unlistenCheckRef` lets us tear the listener down on
  // stop/unmount/restart.
  const activeMonitorIdRef = useRef<string | null>(null);
  const unlistenCheckRef = useRef<(() => void) | null>(null);
  // Guards against a Start double-fire (#1147, GAP #7). The Button's async
  // lifecycle only disables on the *next* click; two clicks in the same tick
  // both reach handleStart before React re-renders the pending state, spawning
  // two backend monitors for one URL. This synchronous ref rejects the second
  // call immediately, so only one start is ever in flight.
  const startInFlightRef = useRef(false);

  const loadMonitors = useCallback(async () => {
    try {
      const list = await networkHttpMonitorList();
      setMonitors(list);
    } catch (err) {
      frontendLog("http_monitor", `Failed to list monitors: ${err}`);
      toast.error(`Failed to refresh monitors: ${err}`);
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

  // Inline validation. A real scheme+host URL check replaces the brittle
  // `url === "https://"` sentinel, and the numeric fields are range-checked.
  const urlValid = isValidHttpUrl(url);
  const urlError = url.trim() && !urlValid ? "Enter a valid http(s) URL" : null;
  const intervalError = validateIntRange(intervalSecs, { min: 1, max: 86_400, label: "Interval" });
  const timeoutError = validateIntRange(timeoutSecs, { min: 1, max: 3600, label: "Timeout" });
  const statusError = validateIntRange(expectedStatus, {
    min: 100,
    max: 599,
    label: "Expected status",
    allowEmpty: true,
  });
  const canStart = urlValid && !intervalError && !timeoutError && !statusError;

  const handleStart = useCallback(async () => {
    if (!canStart) return;
    // Reject a re-entrant start while one is already in flight (#1147, GAP #7).
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
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
        Number(intervalSecs) * 1000,
        method,
        expectedStatus !== "" ? expectedStatus : undefined,
        Number(timeoutSecs) * 1000,
        runLocation
      );
      // Remember where this monitor runs so its row can show the vantage.
      setMonitorLocation(monitorId, runLocation);
      activeMonitorIdRef.current = monitorId;
      setActiveMonitorId(monitorId);
      await loadMonitors();
    } catch (err) {
      stopListening();
      setError(String(err));
      frontendLog("http_monitor", `Start failed: ${err}`);
    } finally {
      startInFlightRef.current = false;
    }
  }, [
    canStart,
    url,
    intervalSecs,
    method,
    expectedStatus,
    timeoutSecs,
    runLocation,
    setMonitorLocation,
    loadMonitors,
    stopListening,
  ]);

  const handleStop = useCallback(async () => {
    if (!activeMonitorIdRef.current) return;
    try {
      await networkHttpMonitorStop(activeMonitorIdRef.current);
      clearActiveMonitor();
      await loadMonitors();
      toast.success("Monitor stopped");
    } catch (err) {
      setError(String(err));
      toast.error(`Failed to stop monitor: ${err}`);
    }
  }, [loadMonitors, clearActiveMonitor]);

  const handleStopMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorStop(id);
        await loadMonitors();
        toast.success("Monitor stopped");
      } catch (err) {
        setError(String(err));
        toast.error(`Failed to stop monitor: ${err}`);
      }
    },
    [loadMonitors]
  );

  const handlePauseMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorPause(id);
        await loadMonitors();
        toast.success("Monitor paused");
      } catch (err) {
        setError(String(err));
        toast.error(`Failed to pause monitor: ${err}`);
      }
    },
    [loadMonitors]
  );

  const handleResumeMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorResume(id);
        await loadMonitors();
        toast.success("Monitor resumed");
      } catch (err) {
        setError(String(err));
        toast.error(`Failed to resume monitor: ${err}`);
      }
    },
    [loadMonitors]
  );

  const handleRemoveMonitor = useCallback(
    async (id: string) => {
      try {
        await networkHttpMonitorRemove(id);
        if (id === activeMonitorIdRef.current) clearActiveMonitor();
        await loadMonitors();
        toast.success("Monitor removed");
      } catch (err) {
        setError(String(err));
        toast.error(`Failed to remove monitor: ${err}`);
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
    <form className="network-panel" data-testid="http-monitor-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">HTTP Monitor</span>
        <div className="network-panel__actions">
          <Tooltip content="Refresh monitor list" side="bottom">
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={loadMonitors}
              aria-label="Refresh monitor list"
            />
          </Tooltip>
          {activeMonitorId ? (
            <Button
              variant="danger"
              size="sm"
              icon={<StopCircle size={14} />}
              pendingLabel="Stopping…"
              errorToast={false}
              onClick={handleStop}
              data-testid="http-monitor-stop"
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
              disabled={!canStart}
              onClick={handleStart}
              data-testid="http-monitor-start"
            >
              Start
            </Button>
          )}
        </div>
      </div>

      <div className="network-panel__form">
        <Field
          className="network-panel__field"
          label="URL"
          htmlFor="http-monitor-url"
          error={urlError ?? undefined}
        >
          <Input
            ref={urlRef}
            id="http-monitor-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={!!urlError}
            placeholder="https://example.com"
            data-testid="http-monitor-url"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Method"
          htmlFor="http-monitor-method"
        >
          <Select
            value={method}
            onChange={setMethod}
            options={HTTP_METHOD_OPTIONS}
            aria-label="HTTP method"
            data-testid="http-monitor-method"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Interval (s)"
          htmlFor="http-monitor-interval"
          error={intervalError ?? undefined}
        >
          <NumberInput
            id="http-monitor-interval"
            min={1}
            value={intervalSecs}
            onValueChange={setIntervalSecs}
            error={!!intervalError}
            data-testid="http-monitor-interval"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Expected status"
          htmlFor="http-monitor-expected-status"
          error={statusError ?? undefined}
        >
          <NumberInput
            id="http-monitor-expected-status"
            value={expectedStatus}
            onValueChange={setExpectedStatus}
            error={!!statusError}
            placeholder="200"
            data-testid="http-monitor-expected-status"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Timeout (s)"
          htmlFor="http-monitor-timeout"
          error={timeoutError ?? undefined}
        >
          <NumberInput
            id="http-monitor-timeout"
            min={1}
            value={timeoutSecs}
            onValueChange={setTimeoutSecs}
            error={!!timeoutError}
            data-testid="http-monitor-timeout"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Run on"
          htmlFor="http-monitor-run-location"
        >
          <RunLocationSelect
            value={runLocation}
            agents={agents}
            onChange={setRunLocation}
            aria-label="Run HTTP monitor on"
            data-testid="http-monitor-run-location"
          />
        </Field>
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

      {/* All monitors (running, paused, and stopped-but-listed) */}
      {monitors.length > 0 && (
        <>
          <div className="network-panel__section-title">Monitors</div>
          {monitors.map((m) => (
            <div
              key={m.config.id}
              className="http-monitor-row"
              data-testid={`monitor-row-${m.config.id}`}
            >
              <span className="http-monitor-row__url" title={m.config.url}>
                {m.config.url}
              </span>
              <span className="http-monitor-row__meta">
                {m.config.method} · every {m.config.intervalMs / 1000}s
                {isAgentHost(monitorLocations[m.config.id] ?? THIS_COMPUTER)
                  ? ` · on ${(monitorLocations[m.config.id] as { agentId: string }).agentId}`
                  : ""}
                {!m.running ? " · stopped" : m.paused ? " · paused" : ""}
              </span>
              {m.running && !m.paused && (
                <Tooltip content="Pause" side="left">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Pause size={13} />}
                    onClick={() => handlePauseMonitor(m.config.id)}
                    aria-label={`Pause monitoring ${m.config.url}`}
                  />
                </Tooltip>
              )}
              {(m.paused || !m.running) && (
                <Tooltip content="Resume" side="left">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Play size={13} />}
                    onClick={() => handleResumeMonitor(m.config.id)}
                    aria-label={`Resume monitoring ${m.config.url}`}
                  />
                </Tooltip>
              )}
              {m.running && (
                <Tooltip content="Stop" side="left">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<StopCircle size={13} />}
                    onClick={() => handleStopMonitor(m.config.id)}
                    aria-label={`Stop monitoring ${m.config.url}`}
                  />
                </Tooltip>
              )}
              <Tooltip content="Remove" side="left">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={13} />}
                  onClick={() => handleRemoveMonitor(m.config.id)}
                  aria-label={`Remove monitor ${m.config.url}`}
                />
              </Tooltip>
            </div>
          ))}
        </>
      )}

      {monitors.length === 0 && !activeMonitorId && (
        <div className="network-panel__placeholder">
          No running monitors. Enter a URL and click Start.
        </div>
      )}
    </form>
  );
}
