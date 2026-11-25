/**
 * Form model for the schedule editor (PROD-043): the zod schema, the
 * conversions between the flat form values and a {@link ScheduleInput}, and
 * the human-readable summaries the list and confirm dialog show.
 *
 * The backend re-validates every save; this schema is the UX-side mirror of
 * `src-tauri/src/schedules/{timing,wire}.rs` so the Save gate matches it.
 */
import { z } from "zod";
import { ITEM_DESCRIPTION_MAX_LENGTH, normalizeItemDescription } from "@/utils/itemDescription";

import { t, tf } from "@/i18n/catalog";
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
import { deletedConnectionLabel } from "@/utils/deletedConnection";

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
  /** Short one-line description (#5757); `""` = none. */
  description: string;
  /** The automation to run (#5818: one picker for every automation). */
  automationId: string;
  targetsKind: ScheduleTargets["kind"];
  connectionIds: string[];
  groupId: string;
  ruleKind: ScheduleRule["kind"];
  everyMinutes: number | "";
  time: string;
  days: ScheduleWeekday[];
  missedRuns: MissedRunPolicy;
  /**
   * What a run does about a target whose connection is closed (#3527, #6024).
   * `""` = not chosen yet: a new schedule must say, because skipping it at night
   * is a run that never happens.
   */
  ifClosed: "" | "connect" | "skip";
}

/** Validation schema for {@link ScheduleFormValues}. */
export const scheduleFormSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    automationId: z.string(),
    targetsKind: z.enum(["connections", "broadcast-group"]),
    connectionIds: z.array(z.string()),
    groupId: z.string(),
    ruleKind: z.enum(["interval", "daily", "weekly"]),
    everyMinutes: z.union([z.number(), z.literal("")]),
    time: z.string(),
    days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])),
    missedRuns: z.enum(["skip", "run-once"]),
    ifClosed: z.enum(["", "connect", "skip"]),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const name = v.name.trim();
    if (name === "") issue("name", "Name is required.");
    else if (name.length > MAX_SCHEDULE_NAME_CHARS) {
      issue("name", `At most ${MAX_SCHEDULE_NAME_CHARS} characters.`);
    }
    if ((normalizeItemDescription(v.description) ?? "").length > ITEM_DESCRIPTION_MAX_LENGTH) {
      issue("description", `At most ${ITEM_DESCRIPTION_MAX_LENGTH} characters.`);
    }
    if (v.automationId === "") issue("automationId", "Pick an automation.");
    if (v.targetsKind === "connections" && v.connectionIds.length === 0) {
      issue("connectionIds", "Pick at least one saved connection.");
    }
    if (v.targetsKind === "broadcast-group" && v.groupId === "") {
      issue("groupId", "Pick a broadcast group.");
    }
    if (v.ifClosed === "") issue("ifClosed", t("schedule.closed.error"));
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
    description: "",
    automationId: action?.automationId ?? "",
    targetsKind: "connections",
    connectionIds: [],
    groupId: "",
    ruleKind: "interval",
    everyMinutes: 15,
    time: "09:00",
    days: ["mon", "tue", "wed", "thu", "fri"],
    missedRuns: "skip",
    ifClosed: "",
  };
}

/** Form values for editing an existing schedule. */
export function scheduleToForm(input: ScheduleInput): ScheduleFormValues {
  const base = blankScheduleForm(input.action);
  return {
    ...base,
    name: input.name,
    description: input.description ?? "",
    targetsKind: input.targets.kind,
    connectionIds: input.targets.kind === "connections" ? [...input.targets.connectionIds] : [],
    groupId: input.targets.kind === "broadcast-group" ? input.targets.groupId : "",
    ruleKind: input.rule.kind,
    everyMinutes: input.rule.kind === "interval" ? input.rule.everyMinutes : base.everyMinutes,
    time: input.rule.kind === "interval" ? base.time : input.rule.time,
    days: input.rule.kind === "weekly" ? [...input.rule.days] : base.days,
    missedRuns: input.missedRuns,
    ifClosed: input.connectIfNeeded === true ? "connect" : "skip",
  };
}

/** The rule the form describes. */
export function ruleOf(v: ScheduleFormValues): ScheduleRule {
  switch (v.ruleKind) {
    case "interval":
      return { kind: "interval", everyMinutes: Number(v.everyMinutes) };
    case "daily":
      return { kind: "daily", time: v.time };
    case "weekly":
      // Stored in week order regardless of click order.
      return {
        kind: "weekly",
        days: SCHEDULE_WEEKDAYS.filter((d) => v.days.includes(d)),
        time: v.time,
      };
  }
}

/** Build the {@link ScheduleInput} a valid form describes. */
export function formToScheduleInput(id: string, v: ScheduleFormValues): ScheduleInput {
  const action: ScheduleAction = { kind: "automation", automationId: v.automationId };
  const targets: ScheduleTargets =
    v.targetsKind === "connections"
      ? { kind: "connections", connectionIds: v.connectionIds }
      : { kind: "broadcast-group", groupId: v.groupId };
  return {
    id,
    name: v.name.trim(),
    description: normalizeItemDescription(v.description),
    action,
    targets,
    rule: ruleOf(v),
    missedRuns: v.missedRuns,
    // Sent only when on, so a schedule that never opted in stays unchanged.
    ...(v.ifClosed === "connect" ? { connectIfNeeded: true } : {}),
  };
}

/**
 * `edited` with every field the user left alone taken from the `stored`
 * schedule instead of rebuilt from the form (#5983). The form cannot hold
 * everything a stored schedule can (a weekday order, `legacySource`), and a
 * rebuilt value that differs would re-time or disable the schedule. `stored` is
 * the latest one, so a save also does not revert what another window changed.
 * `loaded` are the values the form started from.
 */
export function keepUntouched(
  stored: ScheduleInput,
  loaded: ScheduleFormValues,
  values: ScheduleFormValues,
  edited: ScheduleInput
): ScheduleInput {
  const untouched = (...fields: (keyof ScheduleFormValues)[]) =>
    fields.every((f) => JSON.stringify(values[f]) === JSON.stringify(loaded[f]));
  const pick = <T>(kept: boolean, was: T, now: T): T => (kept ? was : now);
  return {
    id: edited.id,
    name: pick(untouched("name"), stored.name, edited.name),
    description: pick(untouched("description"), stored.description, edited.description),
    action: pick(untouched("automationId"), stored.action, edited.action),
    targets: pick(
      untouched("targetsKind", "connectionIds", "groupId"),
      stored.targets,
      edited.targets
    ),
    rule: pick(untouched("ruleKind", "everyMinutes", "time", "days"), stored.rule, edited.rule),
    missedRuns: pick(untouched("missedRuns"), stored.missedRuns, edited.missedRuns),
    connectIfNeeded: pick(untouched("ifClosed"), stored.connectIfNeeded, edited.connectIfNeeded),
  } satisfies { [K in keyof Required<ScheduleInput>]: ScheduleInput[K] };
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

/** What a schedule's targets are called, and whether any of them still exists. */
export interface TargetNames {
  /** For one line: the names, or the group's name. */
  label: string;
  /** Every connection, a deleted one named as such. */
  hosts: string[];
  /** Why there is nothing left to run on (#6024), or `null`. */
  gone: string | null;
}

/** The connection names a schedule targets, resolved for display. */
export function describeTargetNames(
  targets: ScheduleTargets,
  connectionName: (id: string) => string | undefined,
  groups: readonly BroadcastGroup[]
): TargetNames {
  const name = (id: string) => connectionName(id) ?? deletedConnectionLabel(id);
  const live = (ids: string[]) => ids.some((id) => connectionName(id) !== undefined);
  if (targets.kind === "connections") {
    const hosts = targets.connectionIds.map(name);
    const gone = live(targets.connectionIds) ? null : t("schedule.gone.connections");
    return { label: hosts.join(", "), hosts, gone };
  }
  const group = groups.find((g) => g.id === targets.groupId);
  if (!group) {
    return { label: t("schedule.group.deleted"), hosts: [], gone: t("schedule.gone.group") };
  }
  const hosts = group.connectionIds.map(name);
  const gone = live(group.connectionIds) ? null : t("schedule.gone.groupMembers");
  return { label: tf("schedule.group.label", { name: group.name }), hosts, gone };
}
