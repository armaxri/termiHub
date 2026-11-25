import { History, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuSeparator,
  StatusDot,
  Toggle,
  Tooltip,
} from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import { t, tf } from "@/i18n/catalog";
import type { ScheduleView } from "@/types/schedule";
import { describeRule } from "./scheduleForm";
import { attemptTone, lastRunText, scheduleState, summarizeAttempt } from "./scheduleStatus";

/** Props of {@link ScheduleRow}. */
export interface ScheduleRowProps {
  schedule: ScheduleView;
  paused: boolean;
  /** The automation's name. */
  action: string;
  /** The connections' names, or the group's. */
  targets: string;
  /** Why it will not run, or `null`. */
  blocked: string | null;
  /** Choosing another connection would let it run. */
  repairable?: boolean;
  onRepair?: () => void;
  /** It was just saved: tint the row briefly. */
  justSaved?: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onShowHistory: () => void;
  onDelete: () => void;
}

/**
 * One schedule in the list (#6024). Unlike other rows it shows more than names:
 * when it next runs, what it runs where, and how its last run ended and why are
 * the questions the list exists to answer, and nothing else in the app answers
 * them. None of that text is cut. The switch is the only sign of on and off; a
 * coloured dot always means an outcome.
 */
export function ScheduleRow({
  schedule: s,
  paused,
  action,
  targets,
  blocked,
  repairable = false,
  onRepair,
  justSaved = false,
  onToggle,
  onEdit,
  onShowHistory,
  onDelete,
}: ScheduleRowProps) {
  const state = scheduleState(s, paused, blocked !== null);
  const last = s.lastResult ? summarizeAttempt(s.lastResult) : null;
  return (
    <SidebarListItem
      testId={`schedule-item-${s.id}`}
      className={justSaved ? "automation-item--just-saved" : undefined}
      name={s.name}
      nameTestId={`schedule-name-${s.id}`}
      description={s.description}
      descriptionTestId={`schedule-description-${s.id}`}
      actionsVisible
      actions={
        <>
          <Toggle
            checked={s.enabled}
            onCheckedChange={onToggle}
            aria-label={tf(s.enabled ? "schedule.toggle.off" : "schedule.toggle.on", {
              name: s.name,
            })}
            data-testid={`schedule-enable-${s.id}`}
          />
          <Tooltip content="Edit" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Edit ${s.name}`}
              data-testid={`schedule-edit-${s.id}`}
              icon={<Pencil size={12} />}
              onClick={onEdit}
            />
          </Tooltip>
          <DropdownMenuRoot>
            <Tooltip content="More actions" side="top">
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={tf("schedule.menu.label", { name: s.name })}
                  data-testid={`schedule-more-${s.id}`}
                  icon={<MoreHorizontal size={12} />}
                />
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" sideOffset={4}>
              <MenuItem
                icon={<Pencil size={14} />}
                onSelect={onEdit}
                data-testid={`schedule-menu-edit-${s.id}`}
              >
                Edit…
              </MenuItem>
              <MenuItem
                icon={<History size={14} />}
                onSelect={onShowHistory}
                data-testid={`schedule-menu-history-${s.id}`}
              >
                {t("schedule.menu.history")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Trash2 size={14} />}
                danger
                onSelect={onDelete}
                data-testid={`schedule-menu-delete-${s.id}`}
              >
                Delete…
              </MenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
        </>
      }
      details={
        <>
          <span className="schedules__line">
            <span
              className="schedules__state"
              data-state={!s.enabled ? "off" : paused ? "paused" : "on"}
              data-testid={`schedule-status-${s.id}`}
            >
              {state}
            </span>
            {" · "}
            <span data-testid={`schedule-rule-${s.id}`}>{describeRule(s.rule)}</span>
          </span>
          <span className="schedules__line" data-testid={`schedule-what-${s.id}`}>
            {tf("schedule.row.what", { action, targets })}
          </span>
          {blocked ? (
            <span
              className="schedules__line schedules__line--warning"
              data-testid={`schedule-blocked-${s.id}`}
            >
              {blocked}{" "}
              {repairable && (
                <button
                  type="button"
                  className="schedules__link"
                  onClick={onRepair}
                  data-testid={`schedule-repair-${s.id}`}
                >
                  {t("schedule.repair")}
                </button>
              )}
            </span>
          ) : null}
          {last ? (
            <span
              className="schedules__line schedules__line--last"
              data-kind={last.kind}
              data-testid={`schedule-last-${s.id}`}
            >
              <StatusDot tone={attemptTone(last.kind)} size="sm" ariaHidden />
              <span>
                {lastRunText(last)}{" "}
                {last.kind !== "completed" && (
                  <button
                    type="button"
                    className="schedules__link"
                    onClick={onShowHistory}
                    data-testid={`schedule-last-history-${s.id}`}
                  >
                    {t("schedule.menu.history")}
                  </button>
                )}
              </span>
            </span>
          ) : null}
        </>
      }
    />
  );
}
