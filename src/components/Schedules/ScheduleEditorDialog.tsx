import { useEffect, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  NumberInput,
  Select,
} from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { Macro } from "@/types/macro";
import type { ScheduleAction, ScheduleInput } from "@/types/schedule";
import { SCHEDULE_WEEKDAYS } from "@/types/schedule";
import type { BroadcastGroup } from "@/types/terminal";
import type { Workflow } from "@/types/workflow";
import {
  blankScheduleForm,
  formToScheduleInput,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  scheduleFormSchema,
  scheduleToForm,
  weekdayLabel,
  type ScheduleFormValues,
} from "./scheduleForm";
import "./Schedules.css";

export interface ScheduleEditorDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The id the saved schedule gets (existing id, or a fresh one). */
  scheduleId: string;
  /** The schedule being edited, or `null` for a new one. */
  schedule: ScheduleInput | null;
  /** Pre-selected action for a new schedule (from a workflow/macro row). */
  initialAction?: ScheduleAction;
  workflows: Workflow[];
  macros: Macro[];
  connections: SavedConnection[];
  groups: BroadcastGroup[];
  onOpenChange: (open: boolean) => void;
  /** Persist the schedule; may reject (the dialog then stays open). */
  onSave: (input: ScheduleInput) => void | Promise<void>;
}

const ACTION_OPTIONS = [
  { value: "workflow", label: "Workflow" },
  { value: "macro", label: "Macro" },
];
const TARGET_OPTIONS = [
  { value: "connections", label: "Saved connections" },
  { value: "broadcast-group", label: "Broadcast group" },
];
const RULE_OPTIONS = [
  { value: "interval", label: "Every N minutes" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];
const MISSED_OPTIONS = [
  { value: "skip", label: "Skip missed runs" },
  { value: "run-once", label: "Run once when termiHub is back" },
];

/**
 * Create/edit a schedule (PROD-043): what to run (a workflow or a macro), on
 * which saved connections (or broadcast group), and when (every N minutes,
 * daily, or on chosen weekdays at a local time). New schedules are saved
 * **disabled**; they are enabled from the schedules list, which asks for
 * confirmation of the target hosts first.
 */
export function ScheduleEditorDialog({
  open,
  scheduleId,
  schedule,
  initialAction,
  workflows,
  macros,
  connections,
  groups,
  onOpenChange,
  onSave,
}: ScheduleEditorDialogProps) {
  const { control, getValues, reset } = useForm<ScheduleFormValues>({
    defaultValues: blankScheduleForm(),
    resolver: zodResolver(scheduleFormSchema),
    mode: "onChange",
  });

  useEffect(() => {
    if (!open) return;
    reset(schedule ? scheduleToForm(schedule) : blankScheduleForm(initialAction));
  }, [open, schedule, initialAction, reset]);

  const watched = useWatch({ control }) as ScheduleFormValues;
  const validation = useMemo(() => scheduleFormSchema.safeParse(watched), [watched]);
  const errorFor = (path: keyof ScheduleFormValues): string | undefined =>
    validation.success
      ? undefined
      : validation.error.issues.find((i) => i.path[0] === path)?.message;

  const handleSave = () => {
    if (!validation.success) return;
    return onSave(formToScheduleInput(scheduleId, getValues()));
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={schedule ? "Edit Schedule" : "New Schedule"}
      description="Run a workflow or macro on saved connections at set times, while termiHub is running"
      size="md"
      data-testid="schedule-editor-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="schedule-editor-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!validation.success}
            errorToast={false}
            data-testid="schedule-editor-save"
          >
            Save
          </Button>
        </>
      }
    >
      <Controller
        name="name"
        control={control}
        render={({ field }) => (
          <Field label="Name" htmlFor="schedule-editor-name" error={errorFor("name")}>
            <Input
              id="schedule-editor-name"
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              placeholder="Nightly health check"
              data-testid="schedule-editor-name"
            />
          </Field>
        )}
      />

      <div className="schedule-editor__row">
        <Controller
          name="actionKind"
          control={control}
          render={({ field }) => (
            <Field label="Run" htmlFor="schedule-editor-action-kind">
              <Select
                id="schedule-editor-action-kind"
                value={field.value}
                onChange={field.onChange}
                options={ACTION_OPTIONS}
                data-testid="schedule-editor-action-kind"
              />
            </Field>
          )}
        />
        {watched.actionKind === "workflow" ? (
          <Controller
            name="workflowId"
            control={control}
            render={({ field }) => (
              <Field
                label="Workflow"
                htmlFor="schedule-editor-workflow"
                error={errorFor("workflowId")}
              >
                <Select
                  id="schedule-editor-workflow"
                  value={field.value || undefined}
                  onChange={field.onChange}
                  placeholder="Pick a workflow"
                  options={workflows.map((w) => ({ value: w.id, label: w.name }))}
                  data-testid="schedule-editor-workflow"
                />
              </Field>
            )}
          />
        ) : (
          <Controller
            name="macroId"
            control={control}
            render={({ field }) => (
              <Field label="Macro" htmlFor="schedule-editor-macro" error={errorFor("macroId")}>
                <Select
                  id="schedule-editor-macro"
                  value={field.value || undefined}
                  onChange={field.onChange}
                  placeholder="Pick a macro"
                  options={macros.map((m) => ({ value: m.id, label: m.name }))}
                  data-testid="schedule-editor-macro"
                />
              </Field>
            )}
          />
        )}
      </div>

      <Controller
        name="targetsKind"
        control={control}
        render={({ field }) => (
          <Field label="On" htmlFor="schedule-editor-targets-kind">
            <Select
              id="schedule-editor-targets-kind"
              value={field.value}
              onChange={field.onChange}
              options={TARGET_OPTIONS}
              data-testid="schedule-editor-targets-kind"
            />
          </Field>
        )}
      />
      {watched.targetsKind === "connections" ? (
        <Controller
          name="connectionIds"
          control={control}
          render={({ field }) => (
            <Field label="Connections" error={errorFor("connectionIds")}>
              {connections.length === 0 ? (
                <EmptyState title="No saved connections." />
              ) : (
                <div
                  className="schedule-editor__connections"
                  data-testid="schedule-editor-connections"
                >
                  {connections.map((conn) => (
                    <label className="schedule-editor__connection" key={conn.id}>
                      <Checkbox
                        checked={field.value.includes(conn.id)}
                        onCheckedChange={(checked) =>
                          field.onChange(
                            checked
                              ? [...field.value, conn.id]
                              : field.value.filter((id) => id !== conn.id)
                          )
                        }
                        aria-label={conn.name}
                        data-testid={`schedule-editor-connection-${conn.id}`}
                      />
                      <span>{conn.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
          )}
        />
      ) : (
        <Controller
          name="groupId"
          control={control}
          render={({ field }) => (
            <Field
              label="Broadcast group"
              htmlFor="schedule-editor-group"
              error={errorFor("groupId")}
            >
              <Select
                id="schedule-editor-group"
                value={field.value || undefined}
                onChange={field.onChange}
                placeholder={groups.length === 0 ? "No saved broadcast groups" : "Pick a group"}
                disabled={groups.length === 0}
                options={groups.map((g) => ({ value: g.id, label: g.name }))}
                data-testid="schedule-editor-group"
              />
            </Field>
          )}
        />
      )}

      <div className="schedule-editor__row">
        <Controller
          name="ruleKind"
          control={control}
          render={({ field }) => (
            <Field label="When" htmlFor="schedule-editor-rule-kind">
              <Select
                id="schedule-editor-rule-kind"
                value={field.value}
                onChange={field.onChange}
                options={RULE_OPTIONS}
                data-testid="schedule-editor-rule-kind"
              />
            </Field>
          )}
        />
        {watched.ruleKind === "interval" ? (
          <Controller
            name="everyMinutes"
            control={control}
            render={({ field }) => (
              <Field
                label="Minutes"
                htmlFor="schedule-editor-every"
                error={errorFor("everyMinutes")}
              >
                <NumberInput
                  id="schedule-editor-every"
                  value={field.value}
                  onValueChange={field.onChange}
                  min={MIN_INTERVAL_MINUTES}
                  max={MAX_INTERVAL_MINUTES}
                  data-testid="schedule-editor-every"
                />
              </Field>
            )}
          />
        ) : (
          <Controller
            name="time"
            control={control}
            render={({ field }) => (
              <Field label="Local time" htmlFor="schedule-editor-time" error={errorFor("time")}>
                <Input
                  id="schedule-editor-time"
                  type="time"
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                  data-testid="schedule-editor-time"
                />
              </Field>
            )}
          />
        )}
      </div>
      {watched.ruleKind === "weekly" ? (
        <Controller
          name="days"
          control={control}
          render={({ field }) => (
            <Field label="Days" error={errorFor("days")}>
              <div className="schedule-editor__days" data-testid="schedule-editor-days">
                {SCHEDULE_WEEKDAYS.map((day) => {
                  const active = field.value.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`schedule-chip${active ? " schedule-chip--active" : ""}`}
                      aria-pressed={active}
                      onClick={() =>
                        field.onChange(
                          active ? field.value.filter((d) => d !== day) : [...field.value, day]
                        )
                      }
                      data-testid={`schedule-editor-day-${day}`}
                    >
                      {weekdayLabel(day)}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        />
      ) : null}

      <Controller
        name="missedRuns"
        control={control}
        render={({ field }) => (
          <Field
            label="If a run is missed (termiHub closed or the computer asleep)"
            htmlFor="schedule-editor-missed"
          >
            <Select
              id="schedule-editor-missed"
              value={field.value}
              onChange={field.onChange}
              options={MISSED_OPTIONS}
              data-testid="schedule-editor-missed"
            />
          </Field>
        )}
      />
      <p className="schedule-editor__note">
        Runs only while termiHub is open, only on terminals that are already connected, and never
        prompts. New schedules start disabled.
      </p>
    </Modal>
  );
}
