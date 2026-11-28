import { Pause, Play, X, RotateCw, ListX, FolderOpen } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import type { TransferQueueState } from "@/types/transfer";

import { ICON_SIZE } from "@/components/ui/iconSize";
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
  /**
   * Show a finished download in the OS file manager (#5834). Rendered only for a
   * `completed` row, and only when given (a download whose destination is known).
   */
  onReveal?: () => void;
  /** Platform wording for {@link onReveal} ("Reveal in Finder", …). */
  revealLabel?: string;
}

const ICON = ICON_SIZE.sm;

/**
 * State-appropriate action buttons for one Transfer Queue row (#1337).
 *
 * - `active`    → Pause, Cancel
 * - `paused`    → Resume, Cancel
 * - `queued`    → Cancel
 * - `completed` → Reveal in Finder (a download with a known destination), Remove
 * - `failed` / `cancelled` → Retry, Remove
 *
 * Remove only drops the row from the list, so it is a "list ×" icon labelled
 * "Remove from list" — never a trash can, which reads as deleting the file
 * (#5625).
 *
 * Every Transfer Queue row is a queued transfer on the backend's transfer queue
 * — SFTP (PROD-0012), remote-to-remote SFTP (PROD-0013), FTP, Docker and
 * large local / WSL copies (#3567) — and all of them honour pause / resume /
 * retry, so these controls
 * render for every row (#3304). Byte-based remote-agent transfers never create
 * a row.
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
  onReveal,
  revealLabel = "Show in folder",
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

      {state === "completed" && onReveal && (
        <Tooltip content={revealLabel} side="top">
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label={revealLabel}
            data-testid="transfer-reveal"
            icon={<FolderOpen size={ICON} />}
            onClick={onReveal}
          />
        </Tooltip>
      )}

      {(state === "completed" || state === "failed" || state === "cancelled") && (
        <Tooltip content="Remove from list" side="top">
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label="Remove from list"
            data-testid="transfer-remove"
            icon={<ListX size={ICON} />}
            onClick={onRemove}
          />
        </Tooltip>
      )}
    </span>
  );
}
