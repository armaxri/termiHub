import { SchedulesSection } from "@/components/Schedules";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

/**
 * Settings → Schedules (#4623): an always-available place to view, pause and
 * resume, create (#5633), edit (R-017) and delete scheduled automation runs, also for a user
 * who hid the Automations sidebar, where they are listed and edited too:
 * scheduled runs type into remote hosts unattended.
 */
export function SchedulesSettings() {
  return (
    <div className="settings-panel__section" data-testid="schedules-settings">
      <SettingsSectionHeading>Schedules</SettingsSectionHeading>
      <p className="settings-panel__description">
        Scheduled automations send input to their target hosts automatically while termiHub is
        running. Create, edit or delete one here, turn one off, or pause them all.
      </p>
      <SchedulesSection showTitle={false} />
    </div>
  );
}
