import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCw, Skull } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { toast } from "@/components/ui/Toast";
import { listProcesses, killProcess } from "@/services/api";
import type { KillSignal, ProcessInfo } from "@/types/monitoring";
import { frontendLog } from "@/utils/frontendLog";
import "./StatusBar.css";

/** Props for {@link ProcessTablePanel}. */
export interface ProcessTablePanelProps {
  /** Whether the panel is open (controlled). */
  open: boolean;
  /** Called with the next open state (Radix fires `false` on ESC / close / scrim click). */
  onOpenChange: (open: boolean) => void;
  /** Host label shown in the panel title, or `null` when unknown. */
  host: string | null;
  /** Terminal session id whose host's processes are listed / killed. */
  sessionId: string;
}

/** Auto-refresh cadence while the table is visible (ms) — a separate, on-demand
 * loop from the 2s stats sampling, torn down when the panel closes (PROD-0028). */
const PROCESS_REFRESH_INTERVAL_MS = 5000;

/** Which column the table is sorted by. */
type SortKey = "cpu" | "mem";

/** Human-readable signal label for a {@link KillSignal}. */
function signalLabel(signal: KillSignal): string {
  return signal === "kill" ? "SIGKILL" : "SIGTERM";
}

/**
 * The process table (PROD-0028): the top processes on the active session's host
 * by CPU, with a mandatory-confirm kill action.
 *
 * Reads on open and auto-refreshes every {@link PROCESS_REFRESH_INTERVAL_MS}
 * **only while open** — the interval is torn down when the panel closes, so it
 * never competes with the always-on 2s stats sampling. A kill is never fired by
 * a refresh: it requires an explicit {@link ConfirmDialog} confirmation that
 * shows the exact pid + process name and the chosen signal (SIGTERM/SIGKILL).
 *
 * Composed from the shared {@link Modal}, {@link Button}, {@link ConfirmDialog},
 * and {@link RadioGroup} primitives.
 */
export function ProcessTablePanel({ open, onOpenChange, host, sessionId }: ProcessTablePanelProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDesc, setSortDesc] = useState(true);
  // The process pending kill confirmation (`null` when no confirm is open). The
  // kill never fires until the ConfirmDialog is explicitly confirmed.
  const [killTarget, setKillTarget] = useState<ProcessInfo | null>(null);
  const [killSignal, setKillSignal] = useState<KillSignal>("term");

  const refresh = useCallback(
    async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        const list = await listProcesses(sessionId);
        setProcesses(list);
        setError(null);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        frontendLog("process_table", `list_processes failed: ${message}`);
        setError(message);
        // Surface the failure on the first (user-triggered) load; a background
        // refresh failure updates the inline error without a toast spam.
        if (initial) toast.error(`Failed to list processes: ${message}`);
      } finally {
        if (initial) setLoading(false);
      }
    },
    [sessionId]
  );

  // Fetch on open + auto-refresh only while open; tear the interval down on
  // close/unmount so it never runs in the background.
  useEffect(() => {
    if (!open) return;
    void refresh(true);
    const id = window.setInterval(() => void refresh(false), PROCESS_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [open, refresh]);

  const sorted = useMemo(() => {
    const value = (p: ProcessInfo) => (sortKey === "cpu" ? p.cpuPercent : p.memoryPercent);
    const rows = [...processes].sort((a, b) => value(b) - value(a));
    if (!sortDesc) rows.reverse();
    return rows;
  }, [processes, sortKey, sortDesc]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDesc ? " ↓" : " ↑") : "");

  const confirmKill = async () => {
    if (!killTarget) return;
    const { pid, name } = killTarget;
    const signal = killSignal;
    await killProcess(sessionId, pid, signal);
    toast.success(`Sent ${signalLabel(signal)} to ${name} (pid ${pid})`);
    setKillTarget(null);
    // Reflect the kill promptly rather than waiting for the next tick.
    void refresh(false);
  };

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={host ? `Processes — ${host}` : "Processes"}
        description="Top processes by CPU on the active host. Select Kill to terminate a process."
        size="lg"
        data-testid="monitoring-processes-panel"
      >
        {loading && processes.length === 0 ? (
          <EmptyState
            loading
            title="Loading processes…"
            data-testid="monitoring-processes-loading"
          />
        ) : error && processes.length === 0 ? (
          <EmptyState
            title="Couldn't list processes"
            description={error}
            action={
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCw size={14} />}
                onClick={() => refresh(true)}
                data-testid="monitoring-processes-retry"
              >
                Retry
              </Button>
            }
            data-testid="monitoring-processes-error"
          />
        ) : (
          <div className="process-table" role="table" aria-label="Processes">
            <div className="process-table__head" role="row">
              <span className="process-table__col process-table__col--pid" role="columnheader">
                PID
              </span>
              <span className="process-table__col process-table__col--name" role="columnheader">
                Name
              </span>
              <span className="process-table__col process-table__col--user" role="columnheader">
                User
              </span>
              <button
                type="button"
                className="process-table__col process-table__col--num process-table__sort"
                role="columnheader"
                onClick={() => onSort("cpu")}
                data-testid="process-sort-cpu"
              >
                {`CPU%${sortIndicator("cpu")}`}
              </button>
              <button
                type="button"
                className="process-table__col process-table__col--num process-table__sort"
                role="columnheader"
                onClick={() => onSort("mem")}
                data-testid="process-sort-mem"
              >
                {`MEM%${sortIndicator("mem")}`}
              </button>
              <span className="process-table__col process-table__col--action" role="columnheader">
                <span className="sr-only">Actions</span>
              </span>
            </div>
            <div className="process-table__body">
              {sorted.map((p) => (
                <div
                  key={p.pid}
                  className="process-table__row"
                  role="row"
                  data-testid={`process-row-${p.pid}`}
                >
                  <span className="process-table__col process-table__col--pid" role="cell">
                    {p.pid}
                  </span>
                  <span
                    className="process-table__col process-table__col--name"
                    role="cell"
                    title={p.name}
                  >
                    {p.name}
                  </span>
                  <span className="process-table__col process-table__col--user" role="cell">
                    {p.user || "—"}
                  </span>
                  <span className="process-table__col process-table__col--num" role="cell">
                    {p.cpuPercent.toFixed(1)}
                  </span>
                  <span className="process-table__col process-table__col--num" role="cell">
                    {p.memoryPercent.toFixed(1)}
                  </span>
                  <span className="process-table__col process-table__col--action" role="cell">
                    <Button
                      variant="danger"
                      size="xs"
                      iconOnly
                      aria-label={`Kill ${p.name} (pid ${p.pid})`}
                      icon={<Skull size={14} />}
                      onClick={() => {
                        setKillSignal("term");
                        setKillTarget(p);
                      }}
                      data-testid={`process-kill-${p.pid}`}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={killTarget !== null}
        variant="danger"
        title="Kill process?"
        icon={<Skull size={18} />}
        message={
          killTarget
            ? `Send ${signalLabel(killSignal)} to “${killTarget.name}” (pid ${killTarget.pid})? This cannot be undone.`
            : ""
        }
        confirmLabel={killTarget ? `Send ${signalLabel(killSignal)}` : "Kill"}
        testIdBase="confirm-kill-process"
        onConfirm={confirmKill}
        onCancel={() => setKillTarget(null)}
      >
        <RadioGroup
          value={killSignal}
          onValueChange={(v) => setKillSignal(v as KillSignal)}
          orientation="horizontal"
          aria-label="Signal"
          options={[
            { value: "term", label: "SIGTERM (graceful)" },
            { value: "kill", label: "SIGKILL (force)" },
          ]}
          data-testid="confirm-kill-process-signal"
        />
      </ConfirmDialog>
    </>
  );
}
