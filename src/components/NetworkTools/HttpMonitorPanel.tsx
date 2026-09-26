import { useState, useCallback, useEffect, useRef } from "react";
import { Play, StopCircle, RefreshCw } from "lucide-react";
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
import { listHttpMonitorChecks } from "@/services/networkHistoryApi";
import { HttpMonitorChecks } from "./HttpMonitorChecks";
import { HttpMonitorRow } from "./HttpMonitorRow";
import { exportNetworkResults } from "./exportResults";
import { httpMonitorChecksToCsv, mergeChecks } from "./httpMonitorHistory";
import { isValidHttpUrl, validateIntRange } from "@/utils/fieldValidation";
import { frontendLog } from "@/utils/frontendLog";

/** How many of the newest checks the chart shows (and loads from history). */
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
  // Buffers check events that arrive *while a start is in flight* but before the
  // monitor id has come back (#2684). The backend runs an immediate first check
  // the moment its poll task runs, which can be emitted before
  // `networkHttpMonitorStart` resolves — so the listener cannot yet match it by
  // id. Rather than drop it (leaving the panel blank until the next check, up to
  // one full interval — 30s by default — away), buffer it here and reconcile the
  // matching ones once the id is known.
  const pendingChecksRef = useRef<HttpCheckResult[]>([]);

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
    pendingChecksRef.current = [];
  }, []);

  /** Append a check result to the rolling history (capped at MAX_HISTORY). */
  const appendCheck = useCallback((result: HttpCheckResult) => {
    setHistory((prev) => mergeChecks(prev, [result], MAX_HISTORY));
  }, []);

  const clearActiveMonitor = useCallback(() => {
    activeMonitorIdRef.current = null;
    setActiveMonitorId(null);
    setHistory([]);
    stopListening();
  }, [stopListening]);

  /**
   * Display an existing monitor's checks (#3462): rehydrate the chart and table
   * from the backend-recorded history, then keep appending its live checks. The
   * listener is attached before the history loads so no check falls in between;
   * the merge drops a check that is in both.
   */
  const showMonitor = useCallback(
    async (id: string) => {
      stopListening();
      activeMonitorIdRef.current = id;
      setActiveMonitorId(id);
      setHistory([]);
      try {
        const unlisten = await onHttpMonitorCheck((result: HttpCheckResult) => {
          if (result.monitorId === activeMonitorIdRef.current) appendCheck(result);
        });
        // The user may have switched monitors while the listener registered.
        if (activeMonitorIdRef.current !== id) {
          unlisten();
          return;
        }
        unlistenCheckRef.current = unlisten;
        const stored = await listHttpMonitorChecks(id, MAX_HISTORY);
        if (activeMonitorIdRef.current === id) {
          setHistory((prev) => mergeChecks(stored, prev, MAX_HISTORY));
        }
      } catch (err) {
        frontendLog("http_monitor", `Failed to load check history: ${err}`);
      }
    },
    [stopListening, appendCheck]
  );

  /** Export the displayed monitor's full recorded history as CSV. */
  const handleExport = useCallback(async () => {
    const id = activeMonitorIdRef.current;
    if (!id) return;
    let checks = history;
    try {
      checks = mergeChecks(await listHttpMonitorChecks(id), history, Number.MAX_SAFE_INTEGER);
    } catch (err) {
      frontendLog("http_monitor", `Failed to load full check history: ${err}`);
    }
    const url = monitors.find((m) => m.config.id === id)?.config.url ?? id;
    await exportNetworkResults(
      `http-monitor-${url.replace(/^https?:\/\//, "")}`,
      httpMonitorChecksToCsv(checks)
    );
  }, [history, monitors]);

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
      // up to one interval (#1002).
      //
      // Even with the listener attached first, that immediate check can be
      // emitted *before* networkHttpMonitorStart resolves — i.e. before the
      // monitor id is known — so the listener cannot yet match it by id. Buffer
      // such checks and reconcile them once the id is set (#2684); dropping them
      // left the panel blank until the next interval (30s by default) on a fast
      // (e.g. loopback) target.
      unlistenCheckRef.current = await onHttpMonitorCheck((result: HttpCheckResult) => {
        const activeId = activeMonitorIdRef.current;
        if (activeId !== null) {
          if (result.monitorId === activeId) appendCheck(result);
          return;
        }
        // No active id yet: only buffer while our own start is in flight, so a
        // stray event outside a start is still ignored.
        if (startInFlightRef.current) pendingChecksRef.current.push(result);
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
      // Reconcile any checks buffered before the id was known (see the listener).
      const buffered = pendingChecksRef.current;
      pendingChecksRef.current = [];
      for (const result of buffered) {
        if (result.monitorId === monitorId) appendCheck(result);
      }
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
    appendCheck,
  ]);

  const handleStop = useCallback(async () => {
    if (!activeMonitorIdRef.current) return;
    try {
      // Keep the stopped monitor displayed: its checks stay visible (#3462).
      await networkHttpMonitorStop(activeMonitorIdRef.current);
      await loadMonitors();
      toast.success("Monitor stopped");
    } catch (err) {
      setError(String(err));
      toast.error(`Failed to stop monitor: ${err}`);
    }
  }, [loadMonitors]);

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
        // Show the resumed monitor with its past checks rehydrated (#3462).
        if (id !== activeMonitorIdRef.current) await showMonitor(id);
      } catch (err) {
        setError(String(err));
        toast.error(`Failed to resume monitor: ${err}`);
      }
    },
    [loadMonitors, showMonitor]
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

  const activeMonitor = monitors.find((m) => m.config.id === activeMonitorId);
  // The header offers Stop while the displayed monitor runs. A monitor missing
  // from the list was just started (the list refresh is still in flight).
  const activeRunning = activeMonitorId !== null && (activeMonitor?.running ?? true);

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
          {activeRunning ? (
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

      {/* Displayed monitor's checks — persisted history plus live (#3462) */}
      {activeMonitorId && history.length > 0 && (
        <HttpMonitorChecks
          history={history}
          intervalMs={activeMonitor?.config.intervalMs}
          onExport={handleExport}
        />
      )}

      {/* All monitors (running, paused, and stopped-but-listed) */}
      {monitors.length > 0 && (
        <>
          <div className="network-panel__section-title">Monitors</div>
          {monitors.map((m) => {
            const location = monitorLocations[m.config.id] ?? THIS_COMPUTER;
            return (
              <HttpMonitorRow
                key={m.config.id}
                monitor={m}
                agentId={isAgentHost(location) ? location.agentId : undefined}
                onShow={(id) => void showMonitor(id)}
                onPause={handlePauseMonitor}
                onResume={handleResumeMonitor}
                onStop={handleStopMonitor}
                onRemove={handleRemoveMonitor}
              />
            );
          })}
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
