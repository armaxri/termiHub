import { useEffect, useMemo, useRef } from "react";
import { ArrowDownUp, Minus } from "lucide-react";
import { Button, Tooltip, toast, TOAST_AVOID_PROPS } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedTransfers } from "@/store/useProjectedTransfers";
import { useTransferControls } from "@/hooks/useTransferControls";
import { frontendLog } from "@/utils/frontendLog";
import { transferCancel } from "@/services/api";
import {
  formatThroughput,
  isTerminalTransferState,
  summarizeQueueThroughput,
  type TransferEntry,
} from "@/types/transfer";
import { formatElapsed } from "@/utils/formatters";
import { TransferEntryRow } from "./TransferEntry";
import "./TransferQueue.css";

/** Build the header summary (`2 active · 1 queued · 1 done · 1 failed`). */
function summarize(entries: TransferEntry[]): string {
  const count = (s: TransferEntry["state"]) => entries.filter((e) => e.state === s).length;
  const parts: string[] = [];
  const active = count("active") + count("paused");
  if (active) parts.push(`${active} active`);
  if (count("queued")) parts.push(`${count("queued")} queued`);
  if (count("completed")) parts.push(`${count("completed")} done`);
  if (count("failed")) parts.push(`${count("failed")} failed`);
  if (count("cancelled")) parts.push(`${count("cancelled")} cancelled`);
  return parts.join(" · ");
}

/**
 * How long the panel keeps showing a finished queue ("done") before it collapses
 * into the status-bar indicator (#5625).
 */
export const TRANSFER_PANEL_AUTO_COLLAPSE_MS = 3000;

/**
 * Collapse the panel once its work is done (#5625, R-028): a moment after every
 * transfer has **completed**, the panel minimizes into the status-bar indicator
 * so it stops taking room from the terminal. Failed or cancelled rows keep it
 * open — they need the user's attention.
 *
 * The collapse is the panel's own, not the user's, so it is undone the same way:
 * when a new transfer starts after an auto-collapse, the panel comes back. A panel
 * the user minimized stays minimized. Each finished set of transfers collapses at
 * most once, so a user who reopens it from the indicator to look at the rows is
 * not shut out again.
 */
function useAutoCollapse(
  entries: TransferEntry[],
  minimized: boolean,
  setMinimized: (minimized: boolean) => void
) {
  const handledSignature = useRef<string | null>(null);
  const autoCollapsed = useRef(false);

  const allCompleted = entries.length > 0 && entries.every((e) => e.state === "completed");
  const hasPending = entries.some((e) => !isTerminalTransferState(e.state));
  const signature = allCompleted
    ? entries
        .map((e) => e.id)
        .sort()
        .join("\n")
    : null;

  useEffect(() => {
    if (!minimized) {
      // Shown again (by the user or below): the next collapse is a fresh one.
      autoCollapsed.current = false;
    } else if (hasPending && autoCollapsed.current) {
      autoCollapsed.current = false;
      setMinimized(false);
    }
  }, [hasPending, minimized, setMinimized]);

  useEffect(() => {
    if (signature === null) return;
    if (minimized) {
      // Already out of the way: this finished set needs no collapse.
      handledSignature.current = signature;
      return;
    }
    if (handledSignature.current === signature) return;
    const timer = setTimeout(() => {
      handledSignature.current = signature;
      autoCollapsed.current = true;
      setMinimized(true);
    }, TRANSFER_PANEL_AUTO_COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [signature, minimized, setMinimized]);
}

/**
 * The connection-type-agnostic Transfer Queue panel (#1337), docked above the
 * status bar. Shows one {@link TransferEntryRow} per transfer with per-row
 * controls, a header summary + Minimize, and a footer with Clear Completed and
 * Cancel All (shown only while something can be cancelled, #5625). It is the
 * one place transfers are listed; the file browser only links here (#5625).
 *
 * Renders nothing when the queue is empty or minimized — the minimized state is
 * surfaced by the status-bar `TransferQueueIndicator` instead.
 */
export function TransferQueue() {
  // Render from the authoritative `transfers` region (#2229).
  const { queue: transferQueue, minimized } = useProjectedTransfers();
  const removeTransfer = useAppStore((s) => s.removeTransfer);
  const clearCompleted = useAppStore((s) => s.clearCompleted);
  const setMinimized = useAppStore((s) => s.setTransferQueueMinimized);

  const entries = useMemo(() => Object.values(transferQueue), [transferQueue]);
  const summary = useMemo(() => summarize(entries), [entries]);
  const throughput = useMemo(() => summarizeQueueThroughput(entries), [entries]);

  // The per-row control handlers are shared with the file-browser footer so both
  // surfaces drive one control language (UX-020) with honest FEC-004 / UX-016
  // feedback (success only on a real state change, info on a no-op, error toast
  // on rejection). See {@link useTransferControls}.
  const { handlePause, handleResume, handleCancel, handleRetry } = useTransferControls();

  useAutoCollapse(entries, minimized, setMinimized);

  const handleCancelAll = async () => {
    const pending = entries.filter((e) => !isTerminalTransferState(e.state));
    if (pending.length === 0) return;
    const results = await Promise.allSettled(pending.map((e) => transferCancel(e.id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      frontendLog("transfer_queue", `cancelAll: ${failed}/${pending.length} cancels failed`);
      toast.error(`Failed to cancel ${failed} transfer${failed === 1 ? "" : "s"}`);
    } else {
      toast.success(`Canceling ${pending.length} transfer${pending.length === 1 ? "" : "s"}`);
    }
  };

  if (entries.length === 0 || minimized) return null;

  const hasCompleted = entries.some((e) => e.state === "completed");
  const hasPending = entries.some((e) => !isTerminalTransferState(e.state));

  return (
    <div className="transfer-queue" data-testid="transfer-queue" {...TOAST_AVOID_PROPS}>
      <div className="transfer-queue__header">
        <ArrowDownUp size={13} />
        <span className="transfer-queue__title">Transfers</span>
        <span className="transfer-queue__summary" data-testid="transfer-queue-summary">
          {summary}
        </span>
        <div className="transfer-queue__header-actions">
          <Tooltip content="Minimize" side="top">
            <Button
              iconOnly
              variant="ghost"
              size="sm"
              aria-label="Minimize transfer panel"
              data-testid="transfer-minimize"
              icon={<Minus size={14} />}
              onClick={() => setMinimized(true)}
            />
          </Tooltip>
        </div>
      </div>

      <div className="transfer-queue__list">
        {entries.map((entry) => (
          <TransferEntryRow
            key={entry.id}
            entry={entry}
            onPause={handlePause}
            onResume={handleResume}
            onCancel={handleCancel}
            onRetry={handleRetry}
            onRemove={removeTransfer}
          />
        ))}
      </div>

      <div className="transfer-queue__footer">
        {throughput.bytesPerSec != null && (
          <span
            className="transfer-queue__throughput"
            data-testid="transfer-queue-throughput"
            title="Combined rate of the active transfers, and the estimated time until the queue is done"
          >
            {formatThroughput(throughput.bytesPerSec)}
            {throughput.etaSeconds != null && ` · ~${formatElapsed(throughput.etaSeconds)} left`}
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasCompleted}
          data-testid="transfer-clear-completed"
          onClick={() => clearCompleted()}
        >
          Clear completed
        </Button>
        {hasPending && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="transfer-cancel-all"
            onClick={handleCancelAll}
          >
            Cancel all
          </Button>
        )}
      </div>
    </div>
  );
}
