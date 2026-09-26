/**
 * Form model for the schedule editor (PROD-043): the zod schema, the
 * conversions between the flat form values and a {@link ScheduleInput}, and
 * the human-readable summaries the list and confirm dialog show.
 *
 * The backend re-validates every save; this schema is the UX-side mirror of
 * `src-tauri/src/schedules/{timing,wire}.rs` so the Save gate matches it.
 */
import { z } from "zod";

import type { BroadcastGroup } from "@/types/terminal";
import type {
  MissedRunPolicy,
  ScheduleAction,
  ScheduleInput,
  ScheduleRule,
  ScheduleTargets,
  ScheduleWeekday,
} from "@/types/schedule";
import { SCHEDULE_WEEKDAYS } from "@/types/schedule";

/** Shortest interval, in minutes (mirrors the backend). */
export const MIN_INTERVAL_MINUTES = 1;
/** Longest interval — one week — in minutes (mirrors the backend). */
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
/** Longest schedule name (mirrors the backend). */
const MAX_SCHEDULE_NAME_CHARS = 120;

/** `HH:MM`, 24h. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const WEEKDAY_LABELS: Record<ScheduleWeekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** Short display label of a weekday. */
export function weekdayLabel(day: ScheduleWeekday): string {
  return WEEKDAY_LABELS[day];
}

/** The flat values the editor form holds. */
export interface ScheduleFormValues {
  name: string;
  actionKind: ScheduleAction["kind"];
  workflowId: string;
  macroId: string;
  targetsKind: ScheduleTargets["kind"];
  connectionIds: string[];
  groupId: string;
  ruleKind: ScheduleRule["kind"];
  everyMinutes: number | "";
  time: string;
  days: ScheduleWeekday[];
  missedRuns: MissedRunPolicy;
}

/** Validation schema for {@link ScheduleFormValues}. */
export const scheduleFormSchema = z
  .object({
    name: z.string(),
    actionKind: z.enum(["workflow", "macro"]),
    workflowId: z.string(),
    macroId: z.string(),
    targetsKind: z.enum(["connections", "broadcast-group"]),
    connectionIds: z.array(z.string()),
    groupId: z.string(),
    ruleKind: z.enum(["interval", "daily", "weekly"]),
    everyMinutes: z.union([z.number(), z.literal("")]),
    time: z.string(),
    days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])),
    missedRuns: z.enum(["skip", "run-once"]),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const name = v.name.trim();
    if (name === "") issue("name", "Name is required.");
    else if (name.length > MAX_SCHEDULE_NAME_CHARS) {
      issue("name", `At most ${MAX_SCHEDULE_NAME_CHARS} characters.`);
    }
    if (v.actionKind === "workflow" && v.workflowId === "") issue("workflowId", "Pick a workflow.");
    if (v.actionKind === "macro" && v.macroId === "") issue("macroId", "Pick a macro.");
    if (v.targetsKind === "connections" && v.connectionIds.length === 0) {
      issue("connectionIds", "Pick at least one saved connection.");
    }
    if (v.targetsKind === "broadcast-group" && v.groupId === "") {
      issue("groupId", "Pick a broadcast group.");
    }
    if (v.ruleKind === "interval") {
      const n = v.everyMinutes;
      if (n === "" || !Number.isInteger(n) || n < MIN_INTERVAL_MINUTES) {
        issue("everyMinutes", `At least ${MIN_INTERVAL_MINUTES} minute.`);
      } else if (n > MAX_INTERVAL_MINUTES) {
        issue("everyMinutes", `At most ${MAX_INTERVAL_MINUTES} minutes (one week).`);
      }
    } else if (!TIME_RE.test(v.time)) {
      issue("time", "Use a 24-hour time like 09:30.");
    }
    if (v.ruleKind === "weekly" && v.days.length === 0) issue("days", "Pick at least one day.");
  });

/** Form defaults for a new schedule, optionally pre-targeting an action. */
export function blankScheduleForm(action?: ScheduleAction): ScheduleFormValues {
  return {
    name: "",
    actionKind: action?.kind ?? "workflow",
    workflowId: action?.kind === "workflow" ? action.workflowId : "",
    macroId: action?.kind === "macro" ? action.macroId : "",
    targetsKind: "connections",
    connectionIds: [],
    groupId: "",
    ruleKind: "interval",
    everyMinutes: 15,
    time: "09:00",
    days: ["mon", "tue", "wed", "thu", "fri"],
    missedRuns: "skip",
  };
}

/** Form values for editing an existing schedule. */
export function scheduleToForm(input: ScheduleInput): ScheduleFormValues {
  const base = blankScheduleForm(input.action);
  return {
    ...base,
    name: input.name,
    targetsKind: input.targets.kind,
    connectionIds: input.targets.kind === "connections" ? [...input.targets.connectionIds] : [],
    groupId: input.targets.kind === "broadcast-group" ? input.targets.groupId : "",
    ruleKind: input.rule.kind,
    everyMinutes: input.rule.kind === "interval" ? input.rule.everyMinutes : base.everyMinutes,
    time: input.rule.kind === "interval" ? base.time : input.rule.time,
    days: input.rule.kind === "weekly" ? [...input.rule.days] : base.days,
    missedRuns: input.missedRuns,
  };
}

/** Build the {@link ScheduleInput} a valid form describes. */
export function formToScheduleInput(id: string, v: ScheduleFormValues): ScheduleInput {
  const action: ScheduleAction =
    v.actionKind === "workflow"
      ? { kind: "workflow", workflowId: v.workflowId }
      : { kind: "macro", macroId: v.macroId };
  const targets: ScheduleTargets =
    v.targetsKind === "connections"
      ? { kind: "connections", connectionIds: v.connectionIds }
      : { kind: "broadcast-group", groupId: v.groupId };
  let rule: ScheduleRule;
  if (v.ruleKind === "interval") {
    rule = { kind: "interval", everyMinutes: Number(v.everyMinutes) };
  } else if (v.ruleKind === "daily") {
    rule = { kind: "daily", time: v.time };
  } else {
    // Stored in week order regardless of click order.
    const days = SCHEDULE_WEEKDAYS.filter((d) => v.days.includes(d));
    rule = { kind: "weekly", days, time: v.time };
  }
  return { id, name: v.name.trim(), action, targets, rule, missedRuns: v.missedRuns };
}

/** "Every 15 minutes", "Daily at 09:00", "Mon, Fri at 18:30". */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.kind) {
    case "interval":
      return rule.everyMinutes === 1 ? "Every minute" : `Every ${rule.everyMinutes} minutes`;
    case "daily":
      return `Daily at ${rule.time}`;
    case "weekly": {
      const days = SCHEDULE_WEEKDAYS.filter((d) => rule.days.includes(d));
      const label =
        days.length === 7
          ? "Every day"
          : days.length === 5 && !days.includes("sat") && !days.includes("sun")
            ? "Weekdays"
            : days.map(weekdayLabel).join(", ");
      return `${label} at ${rule.time}`;
    }
  }
}

/** The connection names a schedule targets, resolved for display. */
export function describeTargetNames(
  targets: ScheduleTargets,
  connectionName: (id: string) => string | undefined,
  groups: readonly BroadcastGroup[]
): { label: string; hosts: string[] } {
  if (targets.kind === "connections") {
    const hosts = targets.connectionIds.map((id) => connectionName(id) ?? `Unknown (${id})`);
    return { label: hosts.join(", "), hosts };
  }
  const group = groups.find((g) => g.id === targets.groupId);
  if (!group) return { label: "Missing broadcast group", hosts: [] };
  const hosts = group.connectionIds.map((id) => connectionName(id) ?? `Unknown (${id})`);
  return { label: `Group "${group.name}"`, hosts };
}

/** Two-digit `HH:MM` of a date, in local time. */
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * A compact local rendering of a next-run instant: "today 09:00",
 * "tomorrow 09:00", or "Wed 3 Jun 09:00".
 */
export function formatNextRun(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(d) - dayStart(now)) / (24 * 60 * 60 * 1000));
  if (days === 0) return `today ${hhmm(d)}`;
  if (days === 1) return `tomorrow ${hhmm(d)}`;
  const date = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${date} ${hhmm(d)}`;
}
