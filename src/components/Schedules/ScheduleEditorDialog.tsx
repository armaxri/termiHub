import { useEffect, useRef, useState } from "react";
import { ITEM_DESCRIPTION_MAX_LENGTH } from "@/utils/itemDescription";
import { Info } from "lucide-react";
import { Controller } from "react-hook-form";
import { useZodEditorForm } from "@/hooks/useZodEditorForm";
import { useRevealOnSave } from "@/hooks/useRevealedErrors";
import { draftKey } from "@/utils/draftKey";
import {
  Button,
  Field,
  Input,
  Modal,
  ModalClose,
  NumberInput,
  RadioGroup,
  Select,
} from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { Automation } from "@/types/generated/Automation";
import type { ScheduleAction, ScheduleInput } from "@/types/schedule";
import { SCHEDULE_WEEKDAYS } from "@/types/schedule";
import type { BroadcastGroup } from "@/types/terminal";
import {
  unattendedBlockedReason,
  unattendedDefaults,
  unattendedPasswordNote,
} from "@/utils/unattended";
import {
  automationOptions,
  CLOSED_OPTIONS,
  groupOptions,
  MISSED_OPTIONS,
  RULE_OPTIONS,
  TARGET_OPTIONS,
} from "./scheduleEditorOptions";
import { ScheduleConnectionPicker } from "./ScheduleConnectionPicker";
import { needsNewConfirmation, scheduleSummary } from "./scheduleSummary";
import { useNextRun, type PreviewNextRun } from "./useNextRun";
import {
  blankScheduleForm,
  describeTargetNames,
  formToScheduleInput,
  keepUntouched,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  ruleOf,
  scheduleFormSchema,
  scheduleToForm,
  weekdayLabel,
  type ScheduleFormValues,
} from "./scheduleForm";
import { useConnectionIdChanges } from "@/hooks/useFollowConnectionIdChanges";
import { t } from "@/i18n/catalog";
import { useLocalProcessSwitches } from "@/hooks/useExperimentalFeatures";
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
  /** Whether the edited schedule is on. */
  enabled?: boolean;
  /** The global pause switch. */
  paused?: boolean;
  /** Asks the scheduler when a rule would run next (#6024). */
  previewNextRun?: PreviewNextRun;
  onOpenChange: (open: boolean) => void;
  /** Persist the schedule; may reject (the dialog then stays open). */
  onSave: (input: ScheduleInput, then: { switchOn: boolean }) => void | Promise<void>;
  /** Open the automation that cannot run on a schedule. */
  onEditAutomation?: (automation: Automation) => void;
  /** Start at the connections, to repair them (B-017). */
  startAtConnections?: boolean;
}

/** What is still to be given before it can be saved, in words (B-032). */
function missingParts(errors: Partial<Record<keyof ScheduleFormValues, string>>): string[] {
  const parts = (
    ["name", "automationId", "connectionIds", "groupId", "ifClosed", "days", "description"] as const
  ).flatMap((field) => (errors[field] ? [t(`schedule.missing.${field}`)] : []));
  return errors.everyMinutes || errors.time ? [...parts, t("schedule.missing.when")] : parts;
}

/**
 * Create/edit a schedule (PROD-043): which automation to run (one picker,
 * #5818), on which saved connections (or broadcast group), what to do when one
 * of them is closed (a new schedule must choose, #6024), and when (every N
 * minutes, daily, or on chosen weekdays at a local time). The footer says when
 * and where it would run next, or what is still missing. New schedules are saved
 * **off**; "Save and switch on…" asks for confirmation of the target hosts right
 * after, as the list does (B-030).
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
  enabled = false,
  paused = false,
  previewNextRun,
  onOpenChange,
  onSave,
  onEditAutomation,
  startAtConnections = false,
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
  const nameRef = useRef<HTMLInputElement>(null);
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

  // After the dialog has put the focus on the name.
  useEffect(() => {
    if (!open || !startAtConnections) return;
    const timer = window.setTimeout(() => {
      const box = document.getElementById("schedule-editor-connections");
      box?.scrollIntoView?.({ block: "nearest" });
      box?.focus();
    });
    return () => window.clearTimeout(timer);
  }, [open, startAtConnections, scheduleId]);

  const isDirty = baselineKey !== null && draftKey(watched) !== baselineKey;

  // With experimental features off, an automation that can run a local process
  // cannot be scheduled (#5818). A schedule that already runs one keeps it, and
  // the picker says why it will not run; picking another one is not possible.
  const localSwitches = useLocalProcessSwitches();
  const blockedReason = (id: string): string | null => {
    const find = (x: string) => automations.find((a) => a.id === x);
    const automation = find(id);
    return automation ? localProcessBlockedReason(automation, find, localSwitches) : null;
  };
  const blockedPick = blockedReason(watched.automationId);
  const storedPick = watched.automationId === schedule?.action.automationId;
  const pickRefused = blockedPick !== null && !storedPick;

  const errorFor = (path: keyof ScheduleFormValues): string | undefined => errors[path];

  // What the automation cannot do when nobody is there (#6024).
  const findAutomation = (id: string) => automations.find((a) => a.id === id);
  const picked = findAutomation(watched.automationId);
  const cannotRun =
    blockedPick ?? (picked ? unattendedBlockedReason(picked, findAutomation) : null);
  const passwordNote = picked ? unattendedPasswordNote(picked, findAutomation) : null;
  const defaultsNote = picked ? unattendedDefaults(picked) : null;
  const automationNote = cannotRun ?? passwordNote ?? defaultsNote;

  // A connection that was deleted is named and can be removed; a choice of only
  // deleted ones is no choice, unless it is the stored one the user left alone.
  const connectionName = (id: string) => connections.find((c) => c.id === id)?.name;
  const edited = formToScheduleInput(scheduleId, watched);
  const current =
    schedule && loaded.current ? keepUntouched(schedule, loaded.current, watched, edited) : edited;
  const targetNames = describeTargetNames(current.targets, connectionName, groups);
  const noneLeft =
    watched.targetsKind === "connections" &&
    watched.connectionIds.length > 0 &&
    targetNames.gone !== null;
  const targetsRefused = noneLeft && current.targets !== schedule?.targets;

  const next = useNextRun(open ? ruleOf(watched) : null, previewNextRun);
  const summary = scheduleSummary({
    next,
    rule: ruleOf(watched),
    targets: targetNames,
    cannotRun: cannotRun !== null,
    missing: [
      ...missingParts(allErrors),
      ...(pickRefused ? [t("schedule.missing.pick")] : []),
      ...(targetsRefused ? [t("schedule.missing.targets")] : []),
    ],
    ifClosed: watched.ifClosed,
    isOn: schedule !== null && enabled,
    switchesOff: schedule !== null && enabled && needsNewConfirmation(schedule, current),
    paused,
  });

  const handleSave = (switchOn: boolean) => {
    // Save stays enabled while invalid: activating it then points at the problem
    // instead of saving, and the footer says what is missing (B-032).
    if (!canSave) {
      revealAndFocus();
      return;
    }
    if (pickRefused) {
      document.getElementById("schedule-editor-automation")?.focus();
      return;
    }
    if (targetsRefused) {
      document.getElementById("schedule-editor-connections")?.focus();
      return;
    }
    return onSave(current, { switchOn });
  };
  const isOn = schedule !== null && enabled;
  const staysOff = !isOn || (schedule !== null && needsNewConfirmation(schedule, current));
  // Only what would run then can be switched on from here.
  const offerSwitchOn =
    staysOff &&
    cannotRun === null &&
    !noneLeft &&
    (picked !== undefined || watched.automationId === "");

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dirty={isDirty}
      title={schedule ? "Edit schedule" : "New schedule"}
      description="Run an automation on saved connections at set times, while termiHub is open"
      size="lg"
      initialFocusRef={nameRef}
      data-testid="schedule-editor-dialog"
      footer={
        <>
          <div
            className={
              cannotRun !== null
                ? "schedule-editor__summary schedule-editor__summary--cannot"
                : "schedule-editor__summary"
            }
            role="status"
            data-testid="schedule-editor-summary"
          >
            {summary.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
          {/* Routed through the Modal so a dirty form asks first (UX2-004). */}
          <ModalClose>
            <Button variant="secondary" data-testid="schedule-editor-cancel">
              Cancel
            </Button>
          </ModalClose>
          <Button
            variant={offerSwitchOn ? "secondary" : "primary"}
            onClick={() => handleSave(false)}
            errorToast={false}
            data-testid="schedule-editor-save"
          >
            Save
          </Button>
          {offerSwitchOn && (
            <Button
              variant="primary"
              onClick={() => handleSave(true)}
              errorToast={false}
              data-testid="schedule-editor-save-on"
            >
              {t("schedule.save.andSwitchOn")}
            </Button>
          )}
        </>
      }
    >
      <div className="schedule-editor__form" data-testid="schedule-editor-form" {...rootProps}>
        <p className="schedule-editor__note" data-testid="schedule-editor-only-while-open">
          <Info size={14} aria-hidden="true" />
          {t("schedule.onlyWhileOpen")}
        </p>
        <div className="schedule-editor__row">
          <Controller
            name="name"
            control={control}
            render={({ field }) => (
              <Field label="Name" htmlFor="schedule-editor-name" error={errorFor("name")}>
                <Input
                  id="schedule-editor-name"
                  ref={nameRef}
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                  onBlur={field.onBlur}
                  placeholder={picked ? `${picked.name}, daily` : "Nightly health check"}
                  data-testid="schedule-editor-name"
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
                hint={
                  pickRefused || automationNote === null ? undefined : (
                    <span>
                      {automationNote}
                      {cannotRun !== null && picked && onEditAutomation ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="schedules__link"
                            onClick={() => onEditAutomation(picked)}
                            data-testid="schedule-editor-edit-automation"
                          >
                            {t("schedule.editAutomation")}
                          </button>
                        </>
                      ) : null}
                    </span>
                  )
                }
                hintVariant={automationNote === defaultsNote ? "default" : "warning"}
                hintTestId="schedule-editor-automation-note"
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
        </div>
        <div className="schedule-editor__row">
          <div className="schedule-editor__column">
            <Controller
              name="targetsKind"
              control={control}
              render={({ field }) => (
                <Field label="Run on" htmlFor="schedule-editor-targets-kind">
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
                  <Field
                    label="Connections"
                    error={targetsRefused ? t("schedule.gone.pick") : errorFor("connectionIds")}
                  >
                    <ScheduleConnectionPicker
                      connections={connections}
                      selected={field.value}
                      onChange={field.onChange}
                    />
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
                      placeholder={
                        groups.length === 0 ? "No saved broadcast groups" : "Pick a group"
                      }
                      disabled={groups.length === 0 && field.value === ""}
                      options={groupOptions(groups, field.value)}
                      data-testid="schedule-editor-group"
                    />
                  </Field>
                )}
              />
            )}
          </div>
          <Controller
            name="ifClosed"
            control={control}
            render={({ field }) => (
              <Field label={t("schedule.closed.label")} error={errorFor("ifClosed")}>
                <RadioGroup
                  variant="cards"
                  value={field.value}
                  onValueChange={field.onChange}
                  aria-label={t("schedule.closed.label")}
                  options={CLOSED_OPTIONS}
                  data-testid="schedule-editor-closed"
                />
              </Field>
            )}
          />
        </div>
        <div className="schedule-editor__row schedule-editor__row--when">
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
          <Controller
            name="missedRuns"
            control={control}
            render={({ field }) => (
              <Field
                label="If a run is missed"
                htmlFor="schedule-editor-missed"
                hint={t(field.value === "skip" ? "schedule.missed.skip" : "schedule.missed.once")}
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
        <details className="schedule-editor__details">
          <summary data-testid="schedule-editor-details">{t("schedule.details.title")}</summary>
          <p>{t("schedule.connect.help")}</p>
        </details>
      </div>
    </Modal>
  );
}
