import { useRef } from "react";
import { CalendarClock, Hand, Plus } from "lucide-react";
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
import { t } from "@/i18n/catalog";
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
import { TriggerCard } from "./TriggerCard";

/** The trigger kinds, in the order the "Add trigger" menu offers them. */
const AUTOMATION_TRIGGER_KINDS: readonly AutomationTriggerKind[] = [
  "hotkey",
  "on-connect",
  "on-disconnect",
  "on-output-match",
] as const;

/** Props of {@link WhenItRuns}. */
export interface WhenItRunsProps {
  triggers: TriggerDraft[];
  /** The Armed switch of the triggers. */
  triggersEnabled: boolean;
  /** The stored automation's id; `null` while it is new. */
  automationId: string | null;
  /** It has a step that waits for the user, or runs one that does (#6025). */
  waitsForUser: boolean;
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
  waitsForUser,
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
        <Hand size={14} aria-hidden="true" /> When you run it: from the sidebar, the command palette
        or a terminal.
      </p>
      {triggers.length > 0 && (
        <Field
          label="Armed"
          htmlFor="automation-editor-armed"
          layout="inline"
          hint={
            triggersEnabled
              ? "The triggers below can start it."
              : "Off: only a schedule or you can start it."
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
      {waitsForUser && (triggers.length > 0 || linked.length > 0 || scheduleAfterSave) && (
        <p
          className="automation-step__note automation-step__note--warning"
          data-testid="automation-editor-when-waits"
        >
          {t("automation.wait.whenNote")}
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

/** What a closed "When it runs" section says. */
export function whenItRunsSummary(triggers: readonly TriggerDraft[], schedules: number): string {
  const parts = [...new Set(triggers.map((t) => triggerKindLabel(t.trigger.kind)))];
  if (schedules > 0) parts.push(schedules === 1 ? "1 schedule" : `${schedules} schedules`);
  return parts.length > 0 ? parts.join(", ") : "Only when you run it";
}
