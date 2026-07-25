import { Radio } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Tooltip } from "@/components/ui";

/**
 * Status-bar pill for the active broadcast session (#1957, epic #1954).
 *
 * While broadcast is active it shows the mode plus the live target count
 * (`Broadcast (N terminals)`), driven purely off the broadcast store state from
 * the foundation (#1955). Clicking it stops broadcast.
 *
 * When every target is disconnected the pill becomes a warning
 * (`Broadcast (0/N connected)`): input is silently dropped by the fan-out until
 * a target reconnects, and this is the only surface that tells the user why.
 *
 * Renders nothing when broadcast is inactive, keeping the status bar
 * uncluttered.
 */
export function BroadcastStatus() {
  const broadcastActive = useAppStore((s) => s.broadcastActive);
  // Total participating tabs (includes the source). Set size is a stable number,
  // so the selector re-renders only when the target set actually changes.
  const totalTargets = useAppStore((s) => s.broadcastTargetTabIds.size);
  // Connected subset — recomputed from the live tab/session state on every store
  // change; returning a number keeps re-renders limited to real count changes.
  const connectedTargets = useAppStore((s) =>
    s.broadcastActive ? s.getBroadcastTargetTabIds().length : 0
  );
  const stopBroadcast = useAppStore((s) => s.stopBroadcast);

  if (!broadcastActive) return null;

  const isWarning = connectedTargets === 0;
  const label = isWarning
    ? `Broadcast (0/${totalTargets} connected)`
    : `Broadcast (${totalTargets} terminals)`;
  const tooltip = isWarning
    ? "Broadcast is active but no targets are connected — input is dropped until one reconnects. Click to stop."
    : "Broadcasting typed input to all targets — click to stop.";

  return (
    <Tooltip content={tooltip} side="top">
      <button
        className={`status-bar__item status-bar__item--interactive status-bar__item--broadcast${
          isWarning ? " status-bar__item--broadcast-warning" : ""
        }`}
        aria-label={tooltip}
        data-testid="broadcast-status"
        onClick={stopBroadcast}
      >
        <Radio size={12} />
        {label}
      </button>
    </Tooltip>
  );
}
