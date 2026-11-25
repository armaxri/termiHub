import { useEffect, useRef, useState } from "react";
import { ITEM_DESCRIPTION_MAX_LENGTH } from "@/utils/itemDescription";
import { Controller } from "react-hook-form";
import { useZodEditorForm } from "@/hooks/useZodEditorForm";
import { useRevealOnSave } from "@/hooks/useRevealedErrors";
import { draftKey } from "@/utils/draftKey";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  ModalClose,
  NumberInput,
  Select,
  type SelectOption,
} from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { Automation } from "@/types/generated/Automation";
import type { ScheduleAction, ScheduleInput } from "@/types/schedule";
import { SCHEDULE_WEEKDAYS } from "@/types/schedule";
import type { BroadcastGroup } from "@/types/terminal";
import {
  blankScheduleForm,
  formToScheduleInput,
  keepUntouched,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  scheduleFormSchema,
  scheduleToForm,
  weekdayLabel,
  type ScheduleFormValues,
} from "./scheduleForm";
import { useConnectionIdChanges } from "@/hooks/useFollowConnectionIdChanges";
import { t } from "@/i18n/catalog";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { localProcessBlockedReason } from "@/utils/localProcessGate";
import { remapConnectionIdList } from "@/utils/connectionIdChanges";
import "./Schedules.css";

export interface ScheduleEditorDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The id the saved schedule gets (existing id, or a fresh one). */
  scheduleId: string;
  /** The schedule being edited, or `null` for a new one. */
  schedule: ScheduleInput | null;
  /** Pre-selected action for a new schedule (from an automation row). */
  initialAction?: ScheduleAction;
  /** Every stored automation, offered in the one automation picker. */
  automations: Automation[];
  connections: SavedConnection[];
  groups: BroadcastGroup[];
  onOpenChange: (open: boolean) => void;
  /** Persist the schedule; may reject (the dialog then stays open). */
  onSave: (input: ScheduleInput) => void | Promise<void>;
}

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
 * The picker's options: every automation by name, plus the stored id when it
 * no longer resolves, so an edit keeps (and shows) a deleted automation. One
 * that a schedule must not run (#5818) is listed disabled, with the reason.
 */
function automationOptions(
  automations: readonly Automation[],
  selected: string,
  blockedReason: (id: string) => string | null
): SelectOption[] {
  const options: SelectOption[] = automations.map((a) =>
    blockedReason(a.id)
      ? { value: a.id, label: `${a.name} (experimental: runs a local process)`, disabled: true }
      : { value: a.id, label: a.name }
  );
  if (selected && !automations.some((a) => a.id === selected)) {
    options.push({ value: selected, label: "Deleted automation" });
  }
  return options;
}

/**
 * Create/edit a schedule (PROD-043): which automation to run (one picker,
 * #5818), on which saved connections (or broadcast group), and when (every N
 * minutes, daily, or on chosen weekdays at a local time). New schedules are
 * saved **disabled**; they are enabled from the schedules list, which asks for
 * confirmation of the target hosts first.
 *
 * A schedule whose automation was deleted keeps its id: the picker shows it
 * as "Deleted automation" so saving never rewrites the action silently.
 */
export function ScheduleEditorDialog({
  open,
  scheduleId,
  schedule,
  initialAction,
  automations,
  connections,
  groups,
  onOpenChange,
  onSave,
}: ScheduleEditorDialogProps) {
  // The shared RHF + zod scaffold (UISF2-003): `watched` is a complete, stable
  // snapshot of the form, and `errors` / `canSave` update on the same render as
  // the edit.
  const {
    form: { control, getValues, setValue, reset },
    draft: watched,
    errors: allErrors,
    canSave,
  } = useZodEditorForm<ScheduleFormValues>({
    schema: scheduleFormSchema,
    defaultValues: blankScheduleForm(),
  });
  // Errors show once the user edited a field and left it, or tried to save
  // (#5917) — a new schedule does not open with required fields in red.
  // `canSave` still reads every error.
  const {
    shown: errors,
    rootProps,
    revealAndFocus,
    rebaseline,
  } = useRevealOnSave(allErrors, watched);

  // Load the working copy when the dialog opens or switches to another schedule
  // — keyed on the ids, not the objects, so a refresh of the schedules list (a
  // run, or the backend following a connection rename) never clobbers the
  // unsaved edits (#3603).
  const latest = useRef({ schedule, initialAction });
  // The loaded values, to tell an edited form from an untouched one (UX2-004).
  const [baselineKey, setBaselineKey] = useState<string | null>(null);
  latest.current = { schedule, initialAction };
  const loaded = useRef<ScheduleFormValues | null>(null);
  const loadedId = schedule?.id ?? null;
  useEffect(() => {
    if (!open) return;
    const { schedule: current, initialAction: action } = latest.current;
    const initial = current ? scheduleToForm(current) : blankScheduleForm(action);
    loaded.current = initial;
    reset(initial);
    rebaseline(initial);
    setBaselineKey(draftKey(initial));
  }, [open, scheduleId, loadedId, reset, rebaseline]);

  // A connection renamed while the dialog is open: re-point the targets, or
  // saving would write the old id back (#3603).
  useConnectionIdChanges((remap) => {
    const ids = getValues("connectionIds");
    const next = remapConnectionIdList(ids, remap);
    if (next !== ids) setValue("connectionIds", next, { shouldValidate: true });
  }, open);

  const isDirty = baselineKey !== null && draftKey(watched) !== baselineKey;

  // With experimental features off, an automation that can run a local process
  // cannot be scheduled (#5818). A schedule that already runs one keeps it, and
  // the picker says why it will not run; picking another one is not possible.
  const experimental = useExperimentalFeatures();
  const blockedReason = (id: string): string | null => {
    const find = (x: string) => automations.find((a) => a.id === x);
    const automation = find(id);
    return automation ? localProcessBlockedReason(automation, find, experimental) : null;
  };
  const blockedPick = blockedReason(watched.automationId);
  const storedPick = watched.automationId === schedule?.action.automationId;
  const pickRefused = blockedPick !== null && !storedPick;

  const errorFor = (path: keyof ScheduleFormValues): string | undefined => errors[path];

  const handleSave = () => {
    // Save stays reachable while invalid (aria-disabled, not disabled):
    // activating it then points at the problem instead of saving.
    if (!canSave) {
      revealAndFocus();
      return;
    }
    if (pickRefused) {
      document.getElementById("schedule-editor-automation")?.focus();
      return;
    }
    const values = getValues();
    const edited = formToScheduleInput(scheduleId, values);
    return onSave(
      schedule && loaded.current ? keepUntouched(schedule, loaded.current, values, edited) : edited
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dirty={isDirty}
      title={schedule ? "Edit schedule" : "New schedule"}
      description="Run an automation on saved connections at set times, while termiHub is running"
      size="md"
      data-testid="schedule-editor-dialog"
      footer={
        <>
          {/* Routed through the Modal so a dirty form asks first (UX2-004). */}
          <ModalClose>
            <Button variant="secondary" data-testid="schedule-editor-cancel">
              Cancel
            </Button>
          </ModalClose>
          <Button
            variant="primary"
            onClick={handleSave}
            aria-disabled={!canSave || pickRefused}
            data-invalid={!canSave || pickRefused || undefined}
            errorToast={false}
            data-testid="schedule-editor-save"
          >
            Save
          </Button>
        </>
      }
    >
      <div className="schedule-editor__form" data-testid="schedule-editor-form" {...rootProps}>
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
        <Controller
          name="description"
          control={control}
          render={({ field }) => (
            <Field
              label="Description (optional)"
              htmlFor="schedule-editor-description"
              error={errorFor("description")}
            >
              <Input
                id="schedule-editor-description"
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                maxLength={ITEM_DESCRIPTION_MAX_LENGTH}
                placeholder="What this schedule is for"
                data-testid="schedule-editor-description"
              />
            </Field>
          )}
        />

        <Controller
          name="automationId"
          control={control}
          render={({ field }) => (
            <Field
              label="Automation"
              htmlFor="schedule-editor-automation"
              error={pickRefused ? (blockedPick ?? undefined) : errorFor("automationId")}
              hint={storedPick ? (blockedPick ?? undefined) : undefined}
              hintVariant="warning"
            >
              <Select
                id="schedule-editor-automation"
                value={field.value || undefined}
                onChange={field.onChange}
                placeholder={
                  automations.length === 0 ? "No saved automations" : "Pick an automation"
                }
                disabled={automations.length === 0}
                options={automationOptions(automations, field.value, blockedReason)}
                data-testid="schedule-editor-automation"
              />
            </Field>
          )}
        />

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
        <Controller
          name="connectIfNeeded"
          control={control}
          render={({ field }) => (
            <Field
              label={t("schedule.connect.fieldLabel")}
              htmlFor="schedule-editor-connect"
              hint={t("schedule.connect.help")}
            >
              <div className="schedule-editor__connection">
                <Checkbox
                  id="schedule-editor-connect"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  data-testid="schedule-editor-connect"
                />
                <label htmlFor="schedule-editor-connect">{t("schedule.connect.label")}</label>
              </div>
            </Field>
          )}
        />
        <p className="schedule-editor__note">
          Runs only while termiHub is open and never prompts. Without “Connect if not connected” it
          runs only on terminals that are already connected. New schedules start disabled.
        </p>
      </div>
    </Modal>
  );
}
