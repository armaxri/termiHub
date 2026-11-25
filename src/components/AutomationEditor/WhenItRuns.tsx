import { useRef } from "react";
import { CalendarClock, Play, Plus } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  Field,
  MenuItem,
  MenuSeparator,
  Toggle,
  useModalPortalContainer,
} from "@/components/ui";
import { describeRule } from "@/components/Schedules/scheduleForm";
import { useScheduleLabels } from "@/components/Schedules/useScheduleLabels";
import { t, tf } from "@/i18n/catalog";
import { newId } from "@/services/transport/ids";
import { useAppStore } from "@/store/appStore";
import type { ZodFieldErrors } from "@/hooks/useZodEditorForm";
import type { TriggerDraft } from "./automationDraft";
import {
  newTrigger,
  triggerKindIcon,
  triggerKindLabel,
  type AutomationTriggerKind,
} from "./stepMeta";
import {
  triggerPhrases,
  type ConnectionName,
} from "@/components/AutomationSidebar/automationRowInfo";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import type { ScheduleView } from "@/types/schedule";
import { TriggerCard } from "./TriggerCard";

/** The trigger kinds, in the order the "Add trigger" menu offers them. */
const AUTOMATION_TRIGGER_KINDS: readonly AutomationTriggerKind[] = [
  "hotkey",
  "on-connect",
  "on-disconnect",
  "on-output-match",
] as const;

/** What each trigger does, under its name in the menu (B-024). */
const TRIGGER_HINT = {
  hotkey: "automation.triggerHint.hotkey",
  "on-connect": "automation.triggerHint.onConnect",
  "on-disconnect": "automation.triggerHint.onDisconnect",
  "on-output-match": "automation.triggerHint.onOutputMatch",
} as const satisfies Record<AutomationTriggerKind, string>;

/** Props of {@link WhenItRuns}. */
export interface WhenItRunsProps {
  triggers: TriggerDraft[];
  /** The switch of the triggers, hotkeys included. */
  triggersEnabled: boolean;
  /** The stored automation's id; `null` while it is new. */
  automationId: string | null;
  /** The step at which it waits for the user, 1-based (#6025); `null` without one. */
  waitsAt: number | null;
  /** A new automation opens the schedule editor once it is saved. */
  scheduleAfterSave: boolean;
  /** The validation errors the user should see now, by draft path. */
  errors: ZodFieldErrors;
  onTriggersChange: (triggers: TriggerDraft[]) => void;
  onTriggersEnabledChange: (enabled: boolean) => void;
  onScheduleAfterSaveChange: (schedule: boolean) => void;
}

/**
 * When the automation runs (#5818): always when the user runs it, plus any
 * triggers (each with its settings right under it) and the schedules that run
 * it. Schedules stay entries of their own and are only linked here.
 */
export function WhenItRuns({
  triggers,
  triggersEnabled,
  automationId,
  waitsAt,
  scheduleAfterSave,
  errors,
  onTriggersChange,
  onTriggersEnabledChange,
  onScheduleAfterSaveChange,
}: WhenItRunsProps) {
  const portalContainer = useModalPortalContainer();
  const schedules = useAppStore((s) => s.schedules);
  const openScheduleEditor = useAppStore((s) => s.openScheduleEditor);
  const { automations, connections, targets } = useScheduleLabels();
  const others = automations.filter((a) => a.id !== automationId);
  const rootRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // What the Add trigger menu does once it closed, so its button keeps no focus
  // it should not have.
  const afterClose = useRef<(() => void) | null>(null);
  const linked =
    automationId === null ? [] : schedules.filter((s) => s.action.automationId === automationId);

  const addTrigger = (kind: AutomationTriggerKind) => {
    const index = triggers.length;
    onTriggersChange([...triggers, { uid: newId("trigger"), trigger: newTrigger(kind) }]);
    afterClose.current = () =>
      rootRef.current
        ?.querySelector<HTMLElement>(
          `[data-trigger-index="${index}"] .automation-triggers__fields :is(input, button)`
        )
        ?.focus();
  };

  const addSchedule = () => {
    if (automationId === null) {
      onScheduleAfterSaveChange(true);
      return;
    }
    afterClose.current = () => openScheduleEditor({ action: { kind: "automation", automationId } });
  };

  return (
    <div ref={rootRef} className="automation-triggers" data-testid="automation-editor-when">
      <p className="automation-triggers__manual" data-testid="automation-editor-when-manual">
        <Play size={14} aria-hidden="true" /> When you run it: from the sidebar, the command palette
        or a terminal.
      </p>
      {triggers.length > 0 && (
        <Field
          label={t(
            triggersEnabled ? "automation.triggers.onState" : "automation.triggers.offState"
          )}
          htmlFor="automation-editor-armed"
          layout="inline"
          hint={
            triggersEnabled ? t("automation.triggers.editorOn") : t("automation.triggers.editorOff")
          }
        >
          <Toggle
            id="automation-editor-armed"
            checked={triggersEnabled}
            onCheckedChange={onTriggersEnabledChange}
            data-testid="automation-editor-armed"
          />
        </Field>
      )}
      {waitsAt !== null && (triggers.length > 0 || linked.length > 0 || scheduleAfterSave) && (
        <p
          className="automation-step__note automation-step__note--warning"
          data-testid="automation-editor-when-waits"
        >
          {tf("automation.wait.whenNote", { step: waitsAt })}
        </p>
      )}
      {triggers.length > 0 && (
        <ul className="automation-triggers__list" data-testid="automation-editor-triggers">
          {triggers.map(({ uid, trigger }, index) => (
            <TriggerCard
              key={uid}
              trigger={trigger}
              index={index}
              connections={connections}
              automations={others}
              errors={{
                binding: errors[`triggers.${uid}.binding`],
                pattern: errors[`triggers.${uid}.pattern`],
                cooldownMs: errors[`triggers.${uid}.cooldownMs`],
                maxFiresPerSession: errors[`triggers.${uid}.maxFiresPerSession`],
              }}
              onChange={(next) =>
                onTriggersChange(triggers.map((t) => (t.uid === uid ? { ...t, trigger: next } : t)))
              }
              onRemove={() => {
                onTriggersChange(triggers.filter((t) => t.uid !== uid));
                // The removed card takes the focused button with it.
                addRef.current?.focus();
              }}
            />
          ))}
        </ul>
      )}
      {linked.map((schedule) => (
        <div
          key={schedule.id}
          className="automation-triggers__schedule"
          data-testid={`automation-editor-schedule-${schedule.id}`}
        >
          <CalendarClock size={14} aria-hidden="true" />
          <span className="automation-triggers__schedule-text">
            {schedule.name}: {describeRule(schedule.rule)} on {targets(schedule.targets).label}
            {schedule.enabled ? "" : ` · ${t("schedule.state.off")}`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openScheduleEditor({ scheduleId: schedule.id })}
            aria-label={`Edit schedule ${schedule.name}`}
            data-testid={`automation-editor-schedule-edit-${schedule.id}`}
          >
            Edit…
          </Button>
        </div>
      ))}
      {scheduleAfterSave && (
        <div
          className="automation-triggers__schedule"
          data-testid="automation-editor-schedule-pending"
        >
          <CalendarClock size={14} aria-hidden="true" />
          <span className="automation-triggers__schedule-text">
            On a schedule: set it up right after saving.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onScheduleAfterSaveChange(false);
              addRef.current?.focus();
            }}
            aria-label="Remove the schedule to set up"
            data-testid="automation-editor-schedule-pending-remove"
          >
            Remove
          </Button>
        </div>
      )}
      <div>
        <DropdownMenuRoot>
          <DropdownMenuTrigger asChild>
            <Button
              ref={addRef}
              variant="secondary"
              size="sm"
              icon={<Plus size={14} />}
              data-testid="automation-editor-add-trigger"
            >
              Add trigger
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            container={portalContainer}
            align="start"
            sideOffset={4}
            onCloseAutoFocus={(e) => {
              const action = afterClose.current;
              if (!action) return;
              afterClose.current = null;
              e.preventDefault();
              action();
            }}
          >
            {AUTOMATION_TRIGGER_KINDS.map((kind) => {
              const Icon = triggerKindIcon(kind);
              return (
                <MenuItem
                  key={kind}
                  icon={<Icon size={14} />}
                  hint={t(TRIGGER_HINT[kind])}
                  onSelect={() => addTrigger(kind)}
                  data-testid={`automation-editor-add-trigger-${kind}`}
                >
                  {triggerKindLabel(kind)}
                </MenuItem>
              );
            })}
            <MenuSeparator />
            <MenuItem
              icon={<CalendarClock size={14} />}
              hint={t("automation.triggerHint.schedule")}
              onSelect={addSchedule}
              data-testid="automation-editor-add-schedule"
            >
              On a schedule…
            </MenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      </div>
    </div>
  );
}

/** What {@link whenItRunsSummary} reads. */
export interface WhenItRunsSummaryInput {
  triggers: readonly AutomationTrigger[];
  triggersEnabled: boolean;
  schedules: readonly Pick<ScheduleView, "enabled">[];
  connectionName: ConnectionName;
}

/** What a closed "When it runs" section says: which keys and connections, and what is off (B-019). */
export function whenItRunsSummary({
  triggers,
  triggersEnabled,
  schedules,
  connectionName,
}: WhenItRunsSummaryInput): string {
  const parts = triggerPhrases(triggers, connectionName);
  const list =
    parts.length > 0
      ? [triggersEnabled ? parts.join(", ") : `Triggers off (${parts.join(", ")})`]
      : triggers.length > 0
        ? [[...new Set(triggers.map((x) => triggerKindLabel(x.kind)))].join(", ")]
        : [];
  if (schedules.length > 0) {
    const on = schedules.filter((s) => s.enabled).length;
    const name = schedules.length === 1 ? "1 schedule" : `${schedules.length} schedules`;
    list.push(on === schedules.length ? name : `${name} (${on === 0 ? "off" : `${on} on`})`);
  }
  const text = list.join(", ");
  return text ? text[0].toUpperCase() + text.slice(1) : "Only when you run it";
}
