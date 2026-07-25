import { useAppStore } from "@/store/appStore";
import type { PersistentRunState } from "@/types/connection";
import {
  persistentAttachedTabTitles,
  formatAttachedTabsTooltip,
} from "@/utils/persistentTabTitles";

interface PersistentStateDotProps {
  /** Live run-state of the session, or `null` when it has never started. */
  runState: PersistentRunState | null;
  /** CSS modifier class selecting the dot colour for the current run-state. */
  stateDotClass: string;
  /** Store key of the persistent session (plain id, or `agentId:defId`). */
  connectionId: string;
  /** Test hook forwarded to the dot element (kept stable for existing tests). */
  dotTestId?: string;
}

/**
 * Sidebar run-state dot for a persistent session, with an overlaid numeric
 * count badge when the session is `attached` with more than one tab (#1930).
 *
 * The badge shows the attached-tab count (e.g. ●²) and the dot's hover tooltip
 * switches from the bare run-state word to a list of the attached tab names.
 * A single-tab (or non-attached) session renders exactly the plain dot it did
 * before, so nothing changes for the common case.
 */
export function PersistentStateDot({
  runState,
  stateDotClass,
  connectionId,
  dotTestId,
}: PersistentStateDotProps) {
  const attachedCount = useAppStore(
    (s) => s.persistentSessions[connectionId]?.attachedTabIds.length ?? 0
  );
  const showBadge = runState === "attached" && attachedCount > 1;

  // Only resolve the (potentially cross-group) tab titles when the badge is
  // actually shown; the selector returns a stable primitive string so the row
  // does not re-render on unrelated store changes.
  const tooltip = useAppStore((s) =>
    showBadge
      ? formatAttachedTabsTooltip(persistentAttachedTabTitles(s, connectionId))
      : (runState ?? "stopped")
  );

  return (
    <span className="connection-tree__state-dot-wrap">
      <span
        className={`connection-tree__state-dot ${stateDotClass}`}
        title={tooltip}
        data-testid={dotTestId}
      />
      {showBadge && (
        <span
          className="connection-tree__state-badge"
          aria-label={`${attachedCount} attached tabs`}
          data-testid={dotTestId ? `${dotTestId}-badge` : undefined}
        >
          {attachedCount}
        </span>
      )}
    </span>
  );
}
