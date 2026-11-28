import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  Modal,
  Button,
  Checkbox,
  EmptyState,
  Field,
  RadioGroup,
  Select,
  StatusDot,
} from "@/components/ui";
import type { RadioGroupOption } from "@/components/ui";
import { useLocalProcessSwitches } from "@/hooks/useExperimentalFeatures";
import { useAppStore } from "@/store/appStore";
import { WORKFLOW_FANOUT_CONCURRENCY } from "@/store/slices/workflowFanout";
import {
  initialRunTargetChoice,
  rememberRunTargetChoice,
  rememberedRunTargetChoice,
  resolveRunTargetChoice,
  samePanelAsAll,
  type RunTargetChoice,
  type RunTargetKind,
  type RunTargetOptions,
} from "./runTargetChoice";
import { runBlockedReason } from "@/utils/runBlocked";
import { useRunTargets } from "./useRunTargets";
import { RUN_PREVIEW_STEPS, runPreview, stepCountText } from "./runPreview";
import "./RunTargetsDialog.css";
import { connectionStateWord } from "@/utils/connectionStateCopy";

/** An automation the picker can run. */
export interface RunPickerAutomation {
  id: string;
  name: string;
  /** Its step count; `0` disables Run and says why. */
  stepCount: number;
}

/** Props for {@link RunTargetsDialog}. */
export interface RunTargetsDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /**
   * The automations to choose from. With one, the dialog runs that one; with
   * several (the terminal's Play), it shows a selector first.
   */
  automations: RunPickerAutomation[];
  /** The selector's label ("Macro"), when there are several automations. */
  automationLabel?: string;
  /** Shown instead of the form when there is nothing to run. */
  emptyText: string;
  /** Called when the dialog should open/close. */
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the chosen automation, the live terminals it runs on (in tab
   * order) and whether several run at the same time.
   */
  onRun: (automationId: string, tabIds: string[], options: { parallel: boolean }) => void;
}

/** The radio options the current tabs support, in the concept's order. */
function targetOptions(options: RunTargetOptions): RadioGroupOption[] {
  const list: RadioGroupOption[] = [];
  const titleOf = new Map(options.terminals.map((t) => [t.id, t.title]));
  // Which ones, not only how many: two choices can reach the same number (B-007).
  const names = (ids: string[]) =>
    ids.length === 0 ? "none live" : ids.map((id) => titleOf.get(id) ?? id).join(", ");
  const active = options.active;
  list.push({
    value: "active",
    label: active
      ? `This terminal (${active.title}${active.live ? "" : ", not connected"})`
      : "This terminal (none active)",
    disabled: !active,
    "data-testid": "run-targets-target-active",
  });
  if (options.broadcast) {
    list.push({
      value: "broadcast",
      label: `Broadcast set: ${names(options.broadcast)}`,
      "data-testid": "run-targets-target-broadcast",
    });
  }
  // Without a split the two would be the same choice (C-012).
  if (active && !samePanelAsAll(options)) {
    list.push({
      value: "panel",
      label: `Terminals in this split: ${names(options.panel)}`,
      "data-testid": "run-targets-target-panel",
    });
  }
  list.push({
    value: "all",
    label: options.groupName
      ? `All terminals in “${options.groupName}”: ${names(options.all)}`
      : `All terminals: ${names(options.all)}`,
    "data-testid": "run-targets-target-all",
  });
  if (options.groups.length > 0) {
    list.push({ value: "group", label: "Group", "data-testid": "run-targets-target-group" });
  }
  list.push({ value: "pick", label: "Pick terminals…", "data-testid": "run-targets-target-pick" });
  return list;
}

/**
 * The run picker (#5818, slice 5): one dialog that runs an automation on one
 * or more terminals. It replaces the macro Play dialog (PROD-042) and the
 * workflow "Run on…" dialog (PROD-047).
 *
 * "On" offers this terminal, the broadcast set, this split, the tab group, a
 * saved group, or a hand-picked list that shows which terminals are live.
 * Every count is the number of live terminals the run would reach. The
 * dialog opens on the last choice made (while it still applies), else this
 * terminal. A choice that reaches more than one terminal turns Run into
 * "Run on N terminals…" and adds a confirmation step that names every
 * terminal with its machine and what will be typed there (A-035); that step
 * ignores Enter, so a double Enter can never type into a fleet by accident.
 * Whether several run at the same time (the default) is asked as soon as there
 * are several.
 * Typing speed is a saved property of each Type keys step, so the picker does
 * not ask for it.
 */
export function RunTargetsDialog({
  open,
  automations,
  automationLabel = "Automation",
  emptyText,
  onOpenChange,
  onRun,
}: RunTargetsDialogProps) {
  const options = useRunTargets();
  // Read at open time only: sessions connecting or the library reloading must
  // not reset what the user is choosing.
  const atOpen = useRef({ options, automations });
  atOpen.current = { options, automations };
  const [automationId, setAutomationId] = useState<string | undefined>(undefined);
  const [choice, setChoice] = useState<RunTargetChoice>(() =>
    initialRunTargetChoice(rememberedRunTargetChoice(), options)
  );
  // The terminals the confirmation names. Frozen when it opens, so a terminal
  // that connects meanwhile never joins a run the user did not confirm.
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const confirming = confirmIds !== null;

  // Re-seed on every open: the first automation and the remembered choice.
  useEffect(() => {
    if (!open) return;
    setAutomationId(atOpen.current.automations[0]?.id);
    setChoice(initialRunTargetChoice(rememberedRunTargetChoice(), atOpen.current.options));
    setConfirmIds(null);
  }, [open]);

  const radioOptions = useMemo(() => targetOptions(options), [options]);
  const selected = automations.find((a) => a.id === automationId) ?? null;
  const tabIds = confirmIds
    ? options.terminals.filter((t) => t.live && confirmIds.includes(t.id)).map((t) => t.id)
    : resolveRunTargetChoice(choice, options);
  const count = tabIds.length;
  const terminalOf = new Map(options.terminals.map((t) => [t.id, t]));
  const library = useAppStore((s) => s.automations);
  const localSwitches = useLocalProcessSwitches();
  const automation = library.find((a) => a.id === automationId);
  const blocked = automation
    ? runBlockedReason(automation, (id) => library.find((a) => a.id === id), localSwitches)
    : null;
  const canRun = selected !== null && selected.stepCount > 0 && count > 0 && blocked === null;
  const needsConfirm = count > 1;

  const run = () => {
    if (!selected || !canRun) return;
    rememberRunTargetChoice(choice);
    onRun(selected.id, tabIds, { parallel: choice.parallel });
    onOpenChange(false);
  };

  const handleRun = () => {
    if (!canRun) return;
    if (needsConfirm && !confirming) {
      setConfirmIds(tabIds);
      return;
    }
    run();
  };

  const setKind = (kind: string) => {
    const next: RunTargetChoice = { ...choice, kind: kind as RunTargetKind };
    if (kind === "group" && !next.groupId) next.groupId = options.groups[0]?.id;
    if (kind === "pick" && !next.picked) {
      next.picked = options.active?.live ? [options.active.id] : [];
    }
    setChoice(next);
  };

  const togglePicked = (id: string, checked: boolean) => {
    const picked = new Set(choice.picked ?? []);
    if (checked) picked.add(id);
    else picked.delete(id);
    setChoice({ ...choice, picked: [...picked] });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    // The multi-terminal confirmation ignores Enter entirely, including a held
    // Enter on the focused Run button: typing into many hosts needs a click.
    if (confirming) {
      e.preventDefault();
      return;
    }
    // A focused button, select or checkbox handles its own Enter. Only the
    // target radios (which ignore Enter themselves) and the dialog run.
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget && target.getAttribute("role") !== "radio") return;
    if (!e.repeat) handleRun();
  };

  const runLabel = needsConfirm
    ? confirming
      ? `Run on ${count} terminals`
      : `Run on ${count} terminals…`
    : "Run";

  const hint =
    blocked !== null
      ? `Cannot run: ${blocked}`
      : selected && selected.stepCount === 0
        ? "This automation has no steps to run."
        : count === 0
          ? choice.kind === "active"
            ? options.terminals.length === 0
              ? "No terminal is connected. Open one first."
              : "This terminal is not connected."
            : "No live terminals in this choice."
          : null;

  const body = confirming ? (
    <div className="run-targets__confirm" data-testid="run-targets-confirm-step">
      <p className="run-targets__warning" role="alert">
        {`“${selected?.name ?? ""}” will run on ${count} terminals${
          choice.parallel ? " at the same time" : ", one after another"
        }:`}
      </p>
      <ul className="run-targets__confirm-list" data-testid="run-targets-confirm-list">
        {tabIds.map((id) => (
          <li key={id}>
            <span className="run-targets__confirm-title">{terminalOf.get(id)?.title ?? id}</span>
            <span className="run-targets__confirm-where">
              {[terminalOf.get(id)?.where, terminalOf.get(id)?.group].filter(Boolean).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {automation && (
        <div className="run-targets__types" data-testid="run-targets-confirm-steps">
          <p>What it does there ({stepCountText(automation.steps.length)}):</p>
          <ol>
            {runPreview(automation, library).map((line, i) => (
              <li key={i} className={i < RUN_PREVIEW_STEPS ? undefined : "run-targets__more"}>
                {line}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  ) : automations.length === 0 ? (
    <EmptyState title={emptyText} data-testid="run-targets-empty" />
  ) : (
    <>
      {automations.length > 1 && (
        <Field label={automationLabel} htmlFor="run-targets-automation">
          <Select
            value={automationId}
            onChange={setAutomationId}
            options={automations.map((a) => ({ value: a.id, label: a.name }))}
            aria-label={automationLabel}
            data-testid="run-targets-automation"
          />
        </Field>
      )}
      <Field label="Run in">
        <RadioGroup
          value={choice.kind}
          onValueChange={setKind}
          options={radioOptions}
          aria-label="Run on"
          data-testid="run-targets-target"
        />
      </Field>
      {choice.kind === "group" && (
        <Field label="Group" htmlFor="run-targets-group">
          <Select
            value={choice.groupId}
            onChange={(groupId) => setChoice({ ...choice, groupId })}
            options={options.groups.map((g) => ({
              value: g.id,
              label: `${g.name} (${g.tabIds.length})`,
            }))}
            aria-label="Broadcast group"
            data-testid="run-targets-group"
          />
        </Field>
      )}
      {choice.kind === "pick" && (
        <ul className="run-targets__terminals" data-testid="run-targets-terminal-list">
          {options.terminals.map((t) => (
            <li key={t.id} className="run-targets__terminal">
              <Checkbox
                id={`run-targets-terminal-${t.id}`}
                checked={t.live && (choice.picked ?? []).includes(t.id)}
                disabled={!t.live}
                onCheckedChange={(checked) => togglePicked(t.id, checked)}
                data-testid={`run-targets-terminal-${t.id}`}
              />
              <StatusDot
                tone={t.live ? "connected" : "disconnected"}
                size="sm"
                label={t.live ? "Live" : connectionStateWord("notConnected")}
              />
              <label htmlFor={`run-targets-terminal-${t.id}`}>
                {t.title}{" "}
                <span className="run-targets__confirm-where">
                  {[t.where, t.group].filter(Boolean).join(" · ")}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {/* A risk decision, so it is not hidden once it applies (A-036). */}
      {needsConfirm && (
        <div className="run-targets__option">
          <Checkbox
            id="run-targets-parallel"
            checked={choice.parallel}
            onCheckedChange={(parallel) => setChoice({ ...choice, parallel })}
            data-testid="run-targets-parallel"
          />
          <label htmlFor="run-targets-parallel">
            Run at the same time (up to {WORKFLOW_FANOUT_CONCURRENCY}), not one after another
          </label>
        </div>
      )}
      {hint && (
        <p className="run-targets__hint" role="status" data-testid="run-targets-hint">
          {hint}
        </p>
      )}
    </>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={selected ? `Run “${selected.name}”` : "Run automation"}
      description="Choose the terminals it runs on."
      onKeyDown={handleKeyDown}
      data-testid="run-targets-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => (confirming ? setConfirmIds(null) : onOpenChange(false))}
            data-testid="run-targets-cancel"
          >
            {confirming ? "Back" : "Cancel"}
          </Button>
          <Button
            variant={confirming ? "danger" : "primary"}
            onClick={(e) => {
              // The second half of a double click must not pass the confirmation.
              if (confirming && e.detail > 1) return;
              handleRun();
            }}
            disabled={!canRun}
            data-testid="run-targets-run"
          >
            {runLabel}
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}
