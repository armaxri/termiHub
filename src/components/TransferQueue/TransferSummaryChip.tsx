import { useEffect } from "react";
import { ArrowDownUp, FolderOpen } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedTransfers } from "@/store/useProjectedTransfers";
import { isTerminalTransferState, type TransferEntry } from "@/types/transfer";
import { getBasename } from "@/utils/paths";
import { showTransferSummary } from "./transferSummaryVisibility";
import { latestRevealableDownload, revealDownload, revealDownloadLabel } from "./revealDownload";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./TransferQueue.css";

/** Props for {@link TransferSummaryChip}. */
export interface TransferSummaryChipProps {
  /** The session whose transfers are summarised; `null` renders nothing. */
  sessionId: string | null;
}

const plural = (n: number) => `${n} transfer${n === 1 ? "" : "s"}`;

/**
 * One line for a set of transfers: what is still running wins, then what
 * failed, then what finished (`2 transfers in progress`, `1 transfer failed`,
 * `3 transfers done`).
 */
function summarizeSessionTransfers(entries: TransferEntry[]): string {
  const pending = entries.filter((e) => !isTerminalTransferState(e.state)).length;
  if (pending > 0) return `${plural(pending)} in progress`;
  const failed = entries.filter((e) => e.state === "failed").length;
  if (failed > 0) return `${plural(failed)} failed`;
  const done = entries.filter((e) => e.state === "completed").length;
  if (done > 0) return `${plural(done)} done`;
  return `${plural(entries.length)} cancelled`;
}

/**
 * The file browser's one-line pointer to the Transfers panel (#5625, R-028).
 *
 * Transfers are listed in one place, the docked Transfers panel. The sidebar
 * used to repeat that list for the browsed session, which squeezed the file
 * list; it now shows only this summary of the session's transfers (read from
 * the same authoritative `transfers` region), and clicking it opens the panel.
 *
 * It is the one place a finished transfer is reported (#5834): the "Downloaded
 * …" toast and the status-bar count stay away while it is on screen. Once
 * nothing is running, the download that just finished offers "Reveal in Finder"
 * (worded per platform) beside the line.
 */
export function TransferSummaryChip({ sessionId }: TransferSummaryChipProps) {
  const { queue } = useProjectedTransfers();
  const setMinimized = useAppStore((s) => s.setTransferQueueMinimized);
  const entries = sessionId ? Object.values(queue).filter((t) => t.sessionId === sessionId) : [];
  const visible = sessionId !== null && entries.length > 0;

  // While this line is on screen it is the session's transfer feedback: the
  // "Downloaded …" toast stays away (#5859).
  useEffect(
    () => (visible && sessionId ? showTransferSummary(sessionId) : undefined),
    [visible, sessionId]
  );

  if (!visible) return null;

  const pending = entries.some((e) => !isTerminalTransferState(e.state));
  const failed = !pending && entries.some((e) => e.state === "failed");
  const tone = pending ? "pending" : failed ? "failed" : "settled";
  const revealPath = pending ? null : (latestRevealableDownload(entries)?.localPath ?? null);
  const revealName = revealPath ? getBasename(revealPath) : "";
  const revealLabel = revealDownloadLabel();

  return (
    <div className="transfer-summary-chip__bar">
      <Tooltip content="Show in the transfers panel" side="top">
        <button
          type="button"
          className={`transfer-summary-chip transfer-summary-chip--${tone}`}
          data-testid="file-browser-transfer-summary"
          onClick={() => setMinimized(false)}
        >
          <ArrowDownUp size={ICON_SIZE.xs} aria-hidden="true" />
          <span className="transfer-summary-chip__label">{summarizeSessionTransfers(entries)}</span>
        </button>
      </Tooltip>
      {revealPath && (
        <Tooltip content={`${revealLabel}: ${revealName}`} side="top">
          <Button
            variant="ghost"
            size="xs"
            className="transfer-summary-chip__reveal"
            data-testid="file-browser-transfer-reveal"
            aria-label={`${revealLabel}: ${revealName}`}
            icon={<FolderOpen size={ICON_SIZE.xs} aria-hidden="true" />}
            onClick={() => revealDownload(revealPath)}
          >
            {revealLabel}
          </Button>
        </Tooltip>
      )}
    </div>
  );
}
