import { useCallback } from "react";
import { ConfirmDialog } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import { previewScheduleNextRun } from "@/services/scheduleApi";
import type { ScheduleRule } from "@/types/schedule";
import { formatDayTime } from "@/utils/formatters";
import { describeRule } from "./scheduleForm";
import { useNextRun } from "./useNextRun";

export interface ScheduleEnableConfirmDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The schedule's name. */
  scheduleName: string;
  /** The automation's name. */
  actionLabel: string;
  /** When it runs. */
  rule: ScheduleRule | null;
  /** The hosts it will send input to. */
  hosts: string[];
  /** Why nothing will run, or `null`. */
  gone?: string | null;
  /** It also connects hosts that are not connected (#3527). */
  connects?: boolean;
  /** Switch the schedule on (confirmed). */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * The one-time confirmation before a schedule is first switched on (PROD-043): a
 * scheduled run types into remote hosts unattended, so the user must see and
 * accept exactly which hosts, what, and when.
 */
export function ScheduleEnableConfirmDialog({
  open,
  scheduleName,
  actionLabel,
  rule,
  hosts,
  gone = null,
  connects = false,
  onConfirm,
  onCancel,
}: ScheduleEnableConfirmDialogProps) {
  // A schedule that is off is timed from the moment it is switched on.
  const preview = useCallback((r: ScheduleRule) => previewScheduleNextRun(null, r), []);
  const next = useNextRun(open ? rule : null, preview);
  return (
    <ConfirmDialog
      open={open}
      variant="warn"
      title={tf("schedule.confirm.title", { name: scheduleName })}
      message={
        <div className="schedule-confirm">
          <p>
            {tf("schedule.confirm.message", {
              rule: rule ? describeRule(rule) : "",
              action: actionLabel,
            })}
          </p>
          <ul className="schedule-confirm__hosts" data-testid="schedule-confirm-hosts">
            {hosts.map((host, i) => (
              <li key={`${host}-${i}`}>{host}</li>
            ))}
            {hosts.length === 0 && gone ? (
              <li>{tf("schedule.confirm.gone", { reason: gone })}</li>
            ) : null}
          </ul>
          {gone && hosts.length > 0 ? (
            <p data-testid="schedule-confirm-gone">
              {tf("schedule.confirm.gone", { reason: gone })}
            </p>
          ) : null}
          {next && !gone ? (
            <p data-testid="schedule-confirm-next">
              {tf("schedule.confirm.next", { when: formatDayTime(next) })}
            </p>
          ) : null}
          <p data-testid={connects ? "schedule-confirm-connects" : "schedule-confirm-skips"}>
            {t(connects ? "schedule.connect.confirm" : "schedule.confirm.skips")}
          </p>
          <p>{t("schedule.confirm.foot")}</p>
        </div>
      }
      confirmLabel={t("schedule.confirm.accept")}
      confirmVariant="primary"
      onConfirm={onConfirm}
      onCancel={onCancel}
      confirmOnEnter={false}
      testIdBase="schedule-enable-confirm"
      data-testid="schedule-enable-confirm"
    />
  );
}
