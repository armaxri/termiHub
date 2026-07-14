import { Pause, Play, X, RotateCw, Trash2 } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import type { TransferQueueState } from "@/types/transfer";

/** Props for {@link TransferControls}. */
export interface TransferControlsProps {
  /** Current lifecycle state, driving which controls are shown. */
  state: TransferQueueState;
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
 * - `active`    → Pause, Cancel
 * - `paused`    → Resume, Cancel
 * - `queued`    → Cancel
 * - `completed` → Remove
 * - `failed` / `cancelled` → Retry, Remove
 *
 * Each button composes the shared {@link Button} primitive (ghost, icon-only);
 * async control handlers drive the primitive's pending → error/success
 * lifecycle so every action gives feedback.
 */
export function TransferControls({
  state,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRemove,
}: TransferControlsProps) {
  return (
    <span className="transfer-row__actions">
      {state === "active" && (
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

      {state === "paused" && (
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

      {(state === "failed" || state === "cancelled") && (
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
