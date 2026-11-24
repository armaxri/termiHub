import { SchedulesSection } from "@/components/Schedules";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

/**
 * Settings → Schedules (#4623): an always-available place to view, pause and
 * resume, delete and create (#5633) scheduled automation runs, also for a user
 * who hid the Automations sidebar, where they are listed and edited too:
 * scheduled runs type into remote hosts unattended.
 */
export function SchedulesSettings() {
  return (
    <div className="settings-panel__section" data-testid="schedules-settings">
      <SettingsSectionHeading>Schedules</SettingsSectionHeading>
      <p className="settings-panel__description">
        Scheduled automations send input to their target hosts automatically while termiHub is
        running. Create a schedule, turn one off, pause them all, or delete one here.
      </p>
      <SchedulesSection editable={false} creatable showTitle={false} />
    </div>
  );
}
