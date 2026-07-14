import { ArrowUp, ArrowDown, Clock } from "lucide-react";
import { Progress } from "@/components/ui";
import { formatThroughput, type TransferEntry, type TransferQueueState } from "@/types/transfer";
import { TransferControls } from "./TransferControls";

/** Props for {@link TransferEntryRow}. */
export interface TransferEntryProps {
  /** The transfer to render. */
  entry: TransferEntry;
  /** Pause an active transfer. */
  onPause: (id: string) => void | Promise<void>;
  /** Resume a paused transfer. */
  onResume: (id: string) => void | Promise<void>;
  /** Cancel a queued/active/paused transfer. */
  onCancel: (id: string) => void | Promise<void>;
  /** Retry a failed/cancelled transfer. */
  onRetry: (id: string) => void | Promise<void>;
  /** Remove a terminal row from the queue. */
  onRemove: (id: string) => void;
}

/** Human-readable status text for the row's status cell. */
function statusLabel(entry: TransferEntry): string {
  switch (entry.state) {
    case "queued":
      return "queued";
    case "paused":
      return "paused";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
      return entry.attempt && entry.maxAttempts
        ? `failed (${entry.attempt}/${entry.maxAttempts})`
        : "failed";
    case "active":
    default:
      return "";
  }
}

/**
 * A single Transfer Queue row (#1337): direction icon, name, remote path, a
 * per-state coloured progress bar, percent, throughput, a status label, and the
 * state-appropriate {@link TransferControls}.
 *
 * The progress bar composes the shared {@link Progress} primitive; per-state
 * colour comes from tokens via a BEM modifier class (`transfer-row__bar--*`).
 */
export function TransferEntryRow({
  entry,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRemove,
}: TransferEntryProps) {
  const isUpload = entry.direction === "upload";
  const dirTitle = isUpload ? "Upload" : "Download";
  const status = statusLabel(entry);
  const indeterminate = entry.percent == null && entry.state === "active";
  const state: TransferQueueState = entry.state;

  return (
    <div className="transfer-row" data-testid="transfer-row">
      <span className="transfer-row__dir" title={dirTitle} aria-label={dirTitle}>
        {isUpload ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
      </span>

      <span className="transfer-row__name" title={entry.name} data-testid="transfer-row-name">
        {entry.name}
      </span>

      {entry.path && (
        <span className="transfer-row__path" title={entry.path}>
          {entry.path}
        </span>
      )}

      <Progress
        className={`transfer-row__bar transfer-row__bar--${state}`}
        value={entry.percent ?? 0}
        max={100}
        indeterminate={indeterminate}
        label={`${entry.name} — ${entry.percent != null ? `${entry.percent}%` : dirTitle}`}
      />

      <span className="transfer-row__pct">{entry.percent != null ? `${entry.percent}%` : ""}</span>

      <span className="transfer-row__speed">{formatThroughput(entry.speedBytesPerSec)}</span>

      <span
        className={`transfer-row__status transfer-row__status--${state}`}
        title={entry.error}
        data-testid="transfer-row-status"
      >
        {state === "queued" && <Clock size={12} />}
        {status}
      </span>

      <TransferControls
        state={state}
        onPause={() => onPause(entry.id)}
        onResume={() => onResume(entry.id)}
        onCancel={() => onCancel(entry.id)}
        onRetry={() => onRetry(entry.id)}
        onRemove={() => onRemove(entry.id)}
      />
    </div>
  );
}
