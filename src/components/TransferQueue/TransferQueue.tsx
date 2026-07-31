import { useMemo } from "react";
import { ArrowDownUp, Minus } from "lucide-react";
import { Button, Tooltip, toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedTransfers } from "@/store/useProjectedTransfers";
import { frontendLog } from "@/utils/frontendLog";
import { transferPause, transferResume, transferCancel, transferRetry } from "@/services/api";
import { isTerminalTransferState, type TransferEntry } from "@/types/transfer";
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
 * The connection-type-agnostic Transfer Queue panel (#1337), docked above the
 * status bar. Shows one {@link TransferEntryRow} per transfer with per-row
 * controls, a header summary + Minimize, and a footer with Clear Completed and
 * Cancel All.
 *
 * Renders nothing when the queue is empty or minimized — the minimized state is
 * surfaced by the status-bar `TransferQueueIndicator` instead.
 */
export function TransferQueue() {
  // Render from the projected `transfers` region (parity-safe: it mirrors
  // `appStore` and falls back to it verbatim — #2229 render cut).
  const { queue: transferQueue, minimized } = useProjectedTransfers();
  const removeTransfer = useAppStore((s) => s.removeTransfer);
  const clearCompleted = useAppStore((s) => s.clearCompleted);
  const setMinimized = useAppStore((s) => s.setTransferQueueMinimized);

  const entries = useMemo(() => Object.values(transferQueue), [transferQueue]);
  const summary = useMemo(() => summarize(entries), [entries]);

  const handlePause = async (id: string) => {
    await transferPause(id);
    toast.success("Transfer paused");
  };
  const handleResume = async (id: string) => {
    await transferResume(id);
    toast.success("Transfer resumed");
  };
  const handleCancel = async (id: string) => {
    await transferCancel(id);
    toast.success("Transfer cancelled");
  };
  const handleRetry = async (id: string) => {
    await transferRetry(id);
    toast.success("Retrying transfer");
  };

  const handleCancelAll = async () => {
    const pending = entries.filter((e) => !isTerminalTransferState(e.state));
    if (pending.length === 0) return;
    const results = await Promise.allSettled(pending.map((e) => transferCancel(e.id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      frontendLog("transfer_queue", `cancelAll: ${failed}/${pending.length} cancels failed`);
      toast.error(`Failed to cancel ${failed} transfer${failed === 1 ? "" : "s"}`);
    } else {
      toast.success(`Cancelling ${pending.length} transfer${pending.length === 1 ? "" : "s"}`);
    }
  };

  if (entries.length === 0 || minimized) return null;

  const hasCompleted = entries.some((e) => e.state === "completed");
  const hasPending = entries.some((e) => !isTerminalTransferState(e.state));

  return (
    <div className="transfer-queue" data-testid="transfer-queue">
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
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasCompleted}
          data-testid="transfer-clear-completed"
          onClick={() => clearCompleted()}
        >
          Clear Completed
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasPending}
          data-testid="transfer-cancel-all"
          onClick={handleCancelAll}
        >
          Cancel All
        </Button>
      </div>
    </div>
  );
}
