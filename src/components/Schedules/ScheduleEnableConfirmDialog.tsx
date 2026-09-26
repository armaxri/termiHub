import { ConfirmDialog } from "@/components/ui";

export interface ScheduleEnableConfirmDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The schedule's name. */
  scheduleName: string;
  /** What it runs, e.g. `workflow "Health check"`. */
  actionLabel: string;
  /** When it runs, e.g. "Every 15 minutes". */
  ruleLabel: string;
  /** The hosts it will send input to. */
  hosts: string[];
  /** Enable the schedule (confirmed). */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * The one-time confirmation before a schedule is first enabled (PROD-043): a
 * scheduled run types into remote hosts unattended, so the user must see and
 * accept exactly which hosts, what, and when.
 */
export function ScheduleEnableConfirmDialog({
  open,
  scheduleName,
  actionLabel,
  ruleLabel,
  hosts,
  onConfirm,
  onCancel,
}: ScheduleEnableConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      variant="warn"
      title={`Enable schedule "${scheduleName}"?`}
      message={
        <>
          <p>
            {ruleLabel}, termiHub will run {actionLabel} and send its input — without asking — to
            every connected terminal of:
          </p>
          <ul className="schedule-confirm__hosts" data-testid="schedule-confirm-hosts">
            {hosts.length === 0 ? <li>No hosts (the targets no longer exist)</li> : null}
            {hosts.map((host, i) => (
              <li key={`${host}-${i}`}>{host}</li>
            ))}
          </ul>
          <p>It only runs while termiHub is open. You can pause all schedules at any time.</p>
        </>
      }
      confirmLabel="Enable schedule"
      confirmVariant="primary"
      onConfirm={onConfirm}
      onCancel={onCancel}
      confirmOnEnter={false}
      testIdBase="schedule-enable-confirm"
      data-testid="schedule-enable-confirm"
    />
  );
}
