import { Download } from "lucide-react";
import { Button } from "@/components/ui";
import type { HttpCheckResult } from "@/types/network";
import { resolveUiLocale } from "@/utils/locale";
import { LatencyChart } from "./LatencyChart";

/** How many of the newest checks the "Recent Checks" table lists. */
const TABLE_ROWS = 20;

interface HttpMonitorChecksProps {
  /** The displayed monitor's checks, oldest first (stored + live). */
  history: HttpCheckResult[];
  /** The monitor's real check interval, for the chart's x axis. */
  intervalMs?: number;
  /** Export the monitor's full stored history as CSV. */
  onExport: () => Promise<void>;
}

/**
 * The HTTP monitor panel's check view: response-time chart, summary stats and
 * the most recent checks. The checks come from the persisted history (#3462)
 * plus live ones, so they survive a stop/resume and an app restart.
 */
export function HttpMonitorChecks({ history, intervalMs, onExport }: HttpMonitorChecksProps) {
  const latencyPoints = history.map((r) => r.latencyMs ?? null);
  const successCount = history.filter((r) => r.ok).length;
  const lossPercent =
    history.length > 0 ? ((history.length - successCount) / history.length) * 100 : 0;
  const withLatency = history.filter((r) => r.latencyMs != null);
  const avgMs =
    withLatency.length > 0
      ? withLatency.reduce((a, r) => a + (r.latencyMs ?? 0), 0) / withLatency.length
      : null;
  const last = history[history.length - 1];

  return (
    <>
      <div className="network-panel__chart-section" data-testid="http-monitor-chart">
        <span className="network-panel__chart-title">Response Time</span>
        <LatencyChart points={latencyPoints} intervalMs={intervalMs} />
      </div>
      <div className="network-panel__stats">
        <span>
          Checks: {history.length} · Success: {successCount} · Loss: {lossPercent.toFixed(1)}%
        </span>
        {avgMs != null && <span>Avg response: {avgMs.toFixed(0)}ms</span>}
        <span>
          Last:{" "}
          {last?.ok ? (
            <span className="network-panel__ok">{last.statusCode} OK</span>
          ) : (
            <span className="network-panel__fail">{last?.error ?? "Failed"}</span>
          )}
        </span>
      </div>

      <div className="network-panel__section-title network-panel__section-title--with-action">
        <span>Recent Checks</span>
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={14} />}
          onClick={onExport}
          data-testid="http-monitor-export"
        >
          Export
        </Button>
      </div>
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
              .slice(0, TABLE_ROWS)
              .map((r, i) => (
                <tr
                  key={r.timestampMs}
                  className={r.ok ? "" : "network-panel__row--error"}
                  data-testid={`http-monitor-entry-${i}`}
                >
                  <td>{new Date(r.timestampMs).toLocaleTimeString(resolveUiLocale())}</td>
                  <td>{r.statusCode ?? "—"}</td>
                  <td>{r.latencyMs != null ? `${r.latencyMs}ms` : "—"}</td>
                  <td>{r.ok ? "OK" : (r.error ?? "Failed")}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
