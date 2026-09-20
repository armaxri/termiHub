import { getComposedLayout, useAppStore } from "@/store/appStore";
import type { PersistentRunState } from "@/types/connection";
import {
  persistentAttachedTabTitles,
  formatAttachedTabsTooltip,
} from "@/utils/persistentTabTitles";
import { persistentRunStateLabel } from "@/utils/statusLabel";
import { StatusDot } from "@/components/ui";
import type { StatusTone } from "@/components/ui";

interface PersistentStateDotProps {
  /** Live run-state of the session, or `null` when it has never started. */
  runState: PersistentRunState | null;
  /** Store key of the persistent session (plain id, or `agentId:defId`). */
  connectionId: string;
  /** Test hook forwarded to the dot element (kept stable for existing tests). */
  dotTestId?: string;
}

/** Shared {@link StatusDot} styling for a persistent-session run-state. */
interface RunStateDotStyle {
  /** Tone from the connection/run-state palette. */
  tone: StatusTone;
  /** Pulse while transitioning (starting / stopping). */
  pulse: boolean;
  /** Dim the never-started / stopped dot. */
  dimmed: boolean;
}

/**
 * Map a persistent-session run-state to the shared {@link StatusDot} tone plus
 * its pulse (transitioning) / dimmed (stopped) modifiers, preserving the exact
 * colours the bespoke `connection-tree__state-dot--*` classes used: running →
 * connected, starting/stopping → connecting + pulse, error → error, and
 * stopped/never-started → a dimmed neutral dot.
 */
export function persistentRunStateDotStyle(runState: PersistentRunState | null): RunStateDotStyle {
  switch (runState) {
    case "running":
    case "attached":
      return { tone: "connected", pulse: false, dimmed: false };
    case "starting":
    case "stopping":
      return { tone: "connecting", pulse: true, dimmed: false };
    case "error":
      return { tone: "error", pulse: false, dimmed: false };
    default:
      return { tone: "neutral", pulse: false, dimmed: true };
  }
}

/**
 * Sidebar run-state dot for a persistent session, with an overlaid numeric
 * count badge when the session is `attached` with more than one tab (#1930).
 *
 * The dot renders through the shared {@link StatusDot} primitive (UISF-003);
 * the badge shows the attached-tab count (e.g. ●²) and the dot's hover tooltip
 * switches from the bare run-state word to a list of the attached tab names.
 * A single-tab (or non-attached) session renders exactly the plain dot it did
 * before, so nothing changes for the common case.
 */
export function PersistentStateDot({ runState, connectionId, dotTestId }: PersistentStateDotProps) {
  const attachedCount = useAppStore(
    (s) => s.persistentSessions[connectionId]?.attachedTabIds.length ?? 0
  );
  const showBadge = runState === "attached" && attachedCount > 1;

  // Only resolve the (potentially cross-group) tab titles when the badge is
  // actually shown; the selector returns a stable primitive string so the row
  // does not re-render on unrelated store changes.
  const tooltip = useAppStore((s) =>
    showBadge
      ? formatAttachedTabsTooltip(
          persistentAttachedTabTitles(
            { tabGroups: getComposedLayout(s).tabGroups, persistentSessions: s.persistentSessions },
            connectionId
          )
        )
      : (runState ?? "stopped")
  );

  const { tone, pulse, dimmed } = persistentRunStateDotStyle(runState);

  return (
    <span className="connection-tree__state-dot-wrap">
      <StatusDot
        tone={tone}
        size="sm"
        pulse={pulse}
        dimmed={dimmed}
        label={persistentRunStateLabel(runState)}
        title={tooltip}
        testId={dotTestId}
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
