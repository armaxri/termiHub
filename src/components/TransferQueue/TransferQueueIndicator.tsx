import { ArrowDownUp } from "lucide-react";
import { Tooltip } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedTransfers } from "@/store/useProjectedTransfers";
import { isTerminalTransferState } from "@/types/transfer";
import { isTransferSummaryShown, useTransferSummariesVersion } from "./transferSummaryVisibility";

import { ICON_SIZE } from "@/components/ui/iconSize";
/**
 * Minimized status-bar indicator for the Transfer Queue panel (#1337).
 *
 * Renders only while the panel is minimized and the queue is non-empty. Shows a
 * live count of in-progress transfers (active/queued/paused, falling back to the
 * total when all rows are terminal) and re-expands the panel on click.
 *
 * It stays away while it would only repeat what is on screen (#5834): when every
 * queued transfer belongs to a session whose file browser already shows its
 * "N transfers done" line, that line is the one transfer summary. A transfer of
 * any other session (or a local copy) brings the count back.
 */
export function TransferQueueIndicator() {
  // Render from the authoritative `transfers` region (#2229).
  const { queue: transferQueue, minimized } = useProjectedTransfers();
  const setMinimized = useAppStore((s) => s.setTransferQueueMinimized);
  // Re-render when a file browser's summary line appears or goes away.
  useTransferSummariesVersion();

  const entries = Object.values(transferQueue);
  if (!minimized || entries.length === 0) return null;
  if (entries.every((e) => isTransferSummaryShown(e.sessionId))) return null;

  const inProgress = entries.filter((e) => !isTerminalTransferState(e.state)).length;
  const count = inProgress > 0 ? inProgress : entries.length;
  const label = inProgress > 0 ? `${inProgress} transferring` : `${entries.length} finished`;
  const tooltip = "Show transfer queue";

  return (
    <Tooltip content={tooltip} side="top">
      <button
        className="status-bar__item status-bar__item--interactive"
        aria-label={tooltip}
        data-testid="transfer-queue-indicator"
        onClick={() => setMinimized(false)}
      >
        <ArrowDownUp size={ICON_SIZE.xs} />
        {label}
        <span className="transfer-queue-indicator__count" aria-hidden="true">
          {count}
        </span>
      </button>
    </Tooltip>
  );
}
