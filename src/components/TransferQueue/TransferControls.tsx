import { Pause, Play, X, RotateCw, Trash2 } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import type { TransferQueueState } from "@/types/transfer";

/** Props for {@link TransferControls}. */
export interface TransferControlsProps {
  /** Current lifecycle state, driving which controls are shown. */
  state: TransferQueueState;
  /**
   * Whether this transfer's executor supports pause / resume / retry (audit
   * PROD-009). `false` for legacy SFTP transfers — whose Pause/Resume/Retry
   * controls are inert — so those buttons are hidden rather than shown as dead.
   * Cancel and Remove work for every executor and are unaffected.
   */
  pausable: boolean;
  /** Pause an active transfer. */
  onPause: () => void | Promise<void>;
  /** Resume a paused transfer. */
  onResume: () => void | Promise<void>;
  /** Cancel a queued/active/paused transfer. */
  onCancel: () => void | Promise<void>;
  /** Retry a failed/cancelled transfer. */
  onRetry: () => void | Promise<void>;
  /** Remove a terminal row from the queue (local only). */
  onRemove: () => void;
}

const ICON = 14;

/**
 * State-appropriate action buttons for one Transfer Queue row (#1337).
 *
 * - `active`    → Pause*, Cancel
 * - `paused`    → Resume*, Cancel
 * - `queued`    → Cancel
 * - `completed` → Remove
 * - `failed` / `cancelled` → Retry*, Remove
 *
 * *Pause/Resume/Retry only render for a `pausable` transfer (the FTP rich-queue
 * executor). Legacy SFTP transfers cannot pause/resume/retry, so those controls
 * are hidden for them instead of shown as dead buttons (audit PROD-009). Cancel
 * and Remove always render.
 *
 * Each button composes the shared {@link Button} primitive (ghost, icon-only);
 * async control handlers drive the primitive's pending → error/success
 * lifecycle so every action gives feedback.
 */
export function TransferControls({
  state,
  pausable,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRemove,
}: TransferControlsProps) {
  return (
    <span className="transfer-row__actions">
      {pausable && state === "active" && (
        <Tooltip content="Pause" side="top">
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label="Pause transfer"
            data-testid="transfer-pause"
            icon={<Pause size={ICON} />}
            onClick={onPause}
          />
        </Tooltip>
      )}

      {pausable && state === "paused" && (
        <Tooltip content="Resume" side="top">
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label="Resume transfer"
            data-testid="transfer-resume"
            icon={<Play size={ICON} />}
            onClick={onResume}
          />
        </Tooltip>
      )}

      {pausable && (state === "failed" || state === "cancelled") && (
        <Tooltip content="Retry" side="top">
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label="Retry transfer"
            data-testid="transfer-retry"
            icon={<RotateCw size={ICON} />}
            onClick={onRetry}
          />
        </Tooltip>
      )}

      {(state === "active" || state === "paused" || state === "queued") && (
        <Tooltip content="Cancel" side="top">
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label="Cancel transfer"
            data-testid="transfer-cancel"
            icon={<X size={ICON} />}
            onClick={onCancel}
          />
        </Tooltip>
      )}

      {(state === "completed" || state === "failed" || state === "cancelled") && (
        <Tooltip content="Remove" side="top">
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label="Remove transfer from list"
            data-testid="transfer-remove"
            icon={<Trash2 size={ICON} />}
            onClick={onRemove}
          />
        </Tooltip>
      )}
    </span>
  );
}
