import { CalendarClock } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Tooltip } from "@/components/ui";
import { useScheduleLabels } from "@/components/Schedules/useScheduleLabels";
import { showSchedulesInSidebar } from "@/components/AutomationSidebar/automationSections";

/**
 * Status-bar indicator for scheduled runs (PROD-043): "N schedules on"
 * while any schedule is enabled — scheduled runs type into remote hosts
 * unattended, so their existence must always be visible — or "Schedules
 * paused" under the global pause. Clicking it opens the Schedules section of
 * the Automations sidebar, where the schedules are managed. Renders nothing when no schedule is enabled.
 */
export function ScheduleStatus() {
  const schedules = useAppStore((s) => s.schedules);
  const { automations, connections, blockedShort } = useScheduleLabels();
  const on = schedules.filter((x) => x.enabled);
  const enabled = on.length;
  // One that will not run is on, but nothing starts (B-016).
  // Not before the library and the connections have loaded.
  const loaded = automations.length > 0 && connections.length > 0;
  const blocked = loaded ? on.filter((x) => blockedShort(x) !== null).length : 0;
  const running = useAppStore((s) => s.schedules.some((x) => x.running));
  const paused = useAppStore((s) => s.schedulesPaused);

  if (enabled === 0) return null;

  const label = paused
    ? "Schedules paused"
    : `${enabled} schedule${enabled === 1 ? "" : "s"} on${
        running ? " · running" : ""
      }${blocked > 0 ? ` · ${blocked} will not run` : ""}`;
  const tooltip = paused
    ? "All schedules are paused — no scheduled run fires. Click to manage schedules."
    : "Scheduled automations send input to their target hosts automatically. Click to manage schedules.";

  return (
    <Tooltip content={tooltip} side="top">
      <button
        className="status-bar__item status-bar__item--interactive status-bar__item--with-icon"
        aria-label={tooltip}
        data-testid="schedule-status"
        onClick={showSchedulesInSidebar}
      >
        <CalendarClock size={12} />
        {label}
      </button>
    </Tooltip>
  );
}
