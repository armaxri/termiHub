import { CalendarClock } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Tooltip } from "@/components/ui";

/**
 * Status-bar indicator for scheduled runs (PROD-043): "N schedules active"
 * while any schedule is enabled — scheduled runs type into remote hosts
 * unattended, so their existence must always be visible — or "Schedules
 * paused" under the global pause. Clicking it opens the Workflows sidebar,
 * where the schedules are managed. Renders nothing when no schedule is enabled.
 */
export function ScheduleStatus() {
  const enabled = useAppStore((s) => s.schedules.filter((x) => x.enabled).length);
  const running = useAppStore((s) => s.schedules.some((x) => x.running));
  const paused = useAppStore((s) => s.schedulesPaused);
  const setSidebarView = useAppStore((s) => s.setSidebarView);

  if (enabled === 0) return null;

  const label = paused
    ? "Schedules paused"
    : `${enabled} schedule${enabled === 1 ? "" : "s"} active${running ? " · running" : ""}`;
  const tooltip = paused
    ? "All schedules are paused — no scheduled run fires. Click to manage schedules."
    : "Scheduled workflows/macros send input to their target hosts automatically. Click to manage schedules.";

  return (
    <Tooltip content={tooltip} side="top">
      <button
        className="status-bar__item status-bar__item--interactive"
        aria-label={tooltip}
        data-testid="schedule-status"
        onClick={() => setSidebarView("workflows")}
      >
        <CalendarClock size={12} />
        {label}
      </button>
    </Tooltip>
  );
}
