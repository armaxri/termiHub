import { ArrowDownUp } from "lucide-react";
import { Tooltip } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedTransfers } from "@/store/useProjectedTransfers";
import { isTerminalTransferState } from "@/types/transfer";

/**
 * Minimized status-bar indicator for the Transfer Queue panel (#1337).
 *
 * Renders only while the panel is minimized and the queue is non-empty. Shows a
 * live count of in-progress transfers (active/queued/paused, falling back to the
 * total when all rows are terminal) and re-expands the panel on click.
 */
export function TransferQueueIndicator() {
  // Render from the projected `transfers` region (parity-safe: it mirrors
  // `appStore` and falls back to it verbatim — #2229 render cut).
  const { queue: transferQueue, minimized } = useProjectedTransfers();
  const setMinimized = useAppStore((s) => s.setTransferQueueMinimized);

  const entries = Object.values(transferQueue);
  if (!minimized || entries.length === 0) return null;

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
        <ArrowDownUp size={12} />
        {label}
        <span className="transfer-queue-indicator__count" aria-hidden="true">
          {count}
        </span>
      </button>
    </Tooltip>
  );
}
