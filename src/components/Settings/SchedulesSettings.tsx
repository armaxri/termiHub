import { SchedulesSection } from "@/components/Schedules";

/**
 * Settings → Schedules (#4623): an always-available place to view, pause and
 * resume, and delete scheduled workflow/macro runs. The Workflows sidebar,
 * where schedules are also created and edited, is experimental and hidden
 * when experimental features are off, but scheduled runs still type into
 * remote hosts unattended, so they must stay manageable from here.
 */
export function SchedulesSettings() {
  return (
    <div className="settings-panel__section" data-testid="schedules-settings">
      <h3 className="settings-panel__category-title">Schedules</h3>
      <p className="settings-panel__description">
        Scheduled workflows and macros send input to their target hosts automatically while termiHub
        is running. Turn a schedule off, pause them all, or delete one here.
      </p>
      <SchedulesSection editable={false} />
    </div>
  );
}
