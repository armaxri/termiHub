import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { showSchedulesInSidebar } from "@/components/AutomationSidebar/automationSections";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

/** "3 schedules, 2 on", "1 schedule, off", "No schedules yet". */
export function schedulesSummary(total: number, on: number, paused: boolean): string {
  if (total === 0) return "No schedules yet.";
  const count = total === 1 ? "1 schedule" : `${total} schedules`;
  const state = on === 0 ? "none on" : on === total ? "all on" : `${on} on`;
  return `${count}, ${total === 1 ? (on === 1 ? "on" : "off") : state}${paused ? "; all paused" : ""}.`;
}

/**
 * Settings ▸ Automation ▸ Schedules (#5860, R-018). Schedules have one list, in
 * the Automations sidebar next to the automations they run, where they are
 * created, edited, paused and deleted. This page says so, shows how many there
 * are, and opens that list, also when the Automations view is hidden from the
 * activity bar.
 */
export function SchedulesSettings() {
  const schedules = useAppStore((s) => s.schedules);
  const paused = useAppStore((s) => s.schedulesPaused);
  const on = schedules.filter((s) => s.enabled).length;

  return (
    <div className="settings-panel__section" data-testid="schedules-settings">
      <SettingsSectionHeading>Schedules</SettingsSectionHeading>
      <p className="settings-panel__description">
        Scheduled automations send input to their target hosts automatically while termiHub is
        running. They are listed in the Automations sidebar, next to the automations they run:
        create, edit, turn off or delete one there, or pause them all.
      </p>
      <p className="settings-panel__description" data-testid="schedules-settings-summary">
        {schedulesSummary(schedules.length, on, paused)}
      </p>
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon={<CalendarClock size={14} />}
          onClick={showSchedulesInSidebar}
          data-testid="schedules-settings-open"
        >
          Open schedules
        </Button>
      </div>
    </div>
  );
}
