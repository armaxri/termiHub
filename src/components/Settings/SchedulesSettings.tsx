import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { showSchedulesInSidebar } from "@/components/AutomationSidebar/automationSections";
import { useScheduleTrouble } from "@/components/Schedules/useScheduleTrouble";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

import { ICON_SIZE } from "@/components/ui/iconSize";
/** "3 schedules, 2 on", "1 schedule, off", "No schedules yet". */
export function schedulesSummary(total: number, on: number, paused: boolean): string {
  if (total === 0) return "No schedules yet.";
  const count = total === 1 ? "1 schedule" : `${total} schedules`;
  const state = on === 0 ? "none on" : on === total ? "all on" : `${on} on`;
  return `${count}, ${total === 1 ? (on === 1 ? "on" : "off") : state}${paused ? "; all paused" : ""}.`;
}

/** What needs fixing, as the status bar says it: "1 will not run · 1 failed", or "". */
export function schedulesTroubleText(blocked: number, concern: string): string {
  return [blocked > 0 ? `${blocked} will not run` : "", concern].filter(Boolean).join(" · ");
}

/**
 * Settings ▸ Automation ▸ Schedules (#5860, R-018). Schedules have one list, in
 * the Automations sidebar next to the automations they run, where they are
 * created, edited, paused and deleted. This page says so, shows how many there
 * are and what needs fixing (as the status bar does, G-003), and opens that list,
 * also when the Automations view is hidden from the activity bar.
 */
export function SchedulesSettings() {
  const schedules = useAppStore((s) => s.schedules);
  const paused = useAppStore((s) => s.schedulesPaused);
  const { on, blocked, concern } = useScheduleTrouble();
  const trouble = schedulesTroubleText(blocked, concern);

  return (
    <div className="settings-panel__section" data-testid="schedules-settings">
      <SettingsSectionHeading>Schedules</SettingsSectionHeading>
      <p className="settings-panel__description">
        Scheduled automations send input to their target hosts automatically while termiHub is
        running. They are listed in the Automations sidebar, next to the automations they run:
        create, edit, turn off or delete one there, or pause them all.
      </p>
      <p className="settings-panel__description" data-testid="schedules-settings-summary">
        {schedulesSummary(schedules.length, on.length, paused)}
      </p>
      {trouble && (
        <p className="schedules-settings__trouble" data-testid="schedules-settings-trouble">
          {trouble}.
        </p>
      )}
      <div>
        <Button
          variant={trouble ? "primary" : "secondary"}
          size="sm"
          icon={<CalendarClock size={ICON_SIZE.sm} />}
          onClick={showSchedulesInSidebar}
          data-testid="schedules-settings-open"
        >
          {trouble ? "Fix in automations" : "Open schedules"}
        </Button>
      </div>
    </div>
  );
}
