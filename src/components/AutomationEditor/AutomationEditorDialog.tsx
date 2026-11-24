import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button, Field, Input, LiveRegion, Modal, ModalClose } from "@/components/ui";
import { useEditorKeyboard } from "@/hooks/useEditorKeyboard";
import { useConnectionIdChanges } from "@/hooks/useFollowConnectionIdChanges";
import { useRevealOnSave } from "@/hooks/useRevealedErrors";
import { useAppStore } from "@/store/appStore";
import type { RecordedTake } from "@/store/slices/recordingSlice";
import { showTerminal } from "@/utils/showTerminal";
import type { Automation } from "@/types/generated/Automation";
import { remapTriggerConnections } from "@/utils/connectionIdChanges";
import { ITEM_DESCRIPTION_MAX_LENGTH } from "@/utils/itemDescription";
import {
  draftContentKey,
  fromDraft,
  onlyTypesKeys,
  remapDraftTriggers,
  toDraft,
  visitStepDrafts,
  type AutomationDraft,
  type StepDraft,
} from "./automationDraft";
import { draftErrors, draftValues, stepsWithErrors, STEP_LIST_ERROR } from "./draftValidation";
import { EditorSection } from "./EditorSection";
import { ParametersEditor } from "./ParametersEditor";
import { insertRecording, recordedNote, withRecordedSecrets } from "./recordedSteps";
import { RecordStepsButton } from "./RecordStepsButton";
import { StepEditorProvider, type StepEditorContextValue } from "./stepEditorContext";
import { StepList } from "./StepList";
import { WhenItRuns, whenItRunsSummary } from "./WhenItRuns";
import "./AutomationEditor.css";

/** What the user asked for when saving. */
export interface AutomationSaveRequest {
  /** The automation to store; `null` when an existing one was not changed. */
  automation: Automation | null;
  /** Run it right after saving. */
  run: boolean;
  /** Open the schedule editor for it right after saving. */
  schedule: boolean;
}

/** Props of {@link AutomationEditorDialog}. */
export interface AutomationEditorDialogProps {
  /** The automation to edit, as it was when the editor opened. */
  automation: Automation;
  /** Not stored yet. */
  isNew: boolean;
  /** Dismissed without saving. */
  onClose: () => void;
  /**
   * Store the result. The dialog stays open, with its edits, while this is
   * pending and when it rejects; the caller closes it by unmounting it.
   */
  onSave: (request: AutomationSaveRequest) => Promise<void>;
}

/** A set with `value` added or removed. */
function toggled(set: ReadonlySet<string>, value: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

/** The uid of the automation's own step `el` sits in, if any. */
function outermostStep(el: Element): string | null {
  let step = el.closest<HTMLElement>("[data-step-uid]");
  for (let outer = step; outer; ) {
    step = outer;
    outer = outer.parentElement?.closest<HTMLElement>("[data-step-uid]") ?? null;
  }
  return step?.dataset.stepUid ?? null;
}

/** Every step uid of a list, nested ones included. */
function allUids(steps: readonly StepDraft[]): string[] {
  const uids: string[] = [];
  visitStepDrafts(steps, (step) => uids.push(step.uid));
  return uids;
}

/**
 * The one automation editor (#5818, slice 7), with progressive disclosure: name,
 * description and steps first. Triggers, the values to ask for and tags are
 * sections that open on demand, and an automation that only types keystrokes
 * never shows the values to ask for (its keys are typed exactly, so nothing
 * could use them). Edits are held here and stored only on Save, so closing the
 * dialog discards them after asking.
 *
 * Mount it with a fresh `key` per opening.
 */
export function AutomationEditorDialog({
  automation,
  isNew,
  onClose,
  onSave,
}: AutomationEditorDialogProps) {
  // `base` is what is stored, `initial` its draft: both follow a connection
  // rename, so that alone does not count as an edit (#3603).
  const [base, setBase] = useState(automation);
  const [initial, setInitial] = useState<AutomationDraft>(() => toDraft(automation));
  const [draft, setDraft] = useState<AutomationDraft>(initial);
  const [scheduleAfterSave, setScheduleAfterSave] = useState(false);
  // A new automation's steps are there to be filled in; stored ones read as one
  // line each until asked for (#5637).
  const [expanded, setExpandedSet] = useState<ReadonlySet<string>>(
    () => new Set(isNew ? allUids(initial.steps) : [])
  );
  const [failureOpen, setFailureOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");

  const automations = useAppStore((s) => s.automations);
  const scheduleCount = useAppStore(
    (s) => s.schedules.filter((x) => x.action.automationId === automation.id).length
  );
  const [whenOpen, setWhenOpen] = useState(
    initial.triggers.length > 0 || (!isNew && scheduleCount > 0)
  );
  const [valuesOpen, setValuesOpen] = useState(initial.parameters.length > 0);
  const [tagsOpen, setTagsOpen] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // "Record steps" (slice 8): the editor hides while the user types in a
  // terminal, keeps its draft, and comes back with the recording as a step.
  const recordingHere = useAppStore((s) => s.recording?.intoEditor != null);
  const hasTake = useAppStore((s) =>
    [s.recordedTake, ...s.queuedTakes].some((take) => take?.forEditor)
  );
  const startRecording = useAppStore((s) => s.startRecording);
  const takeForEditor = useAppStore((s) => s.takeForEditor);
  const [recorded, setRecorded] = useState<{ take: RecordedTake; uid: string | null } | null>(null);
  const lastStepUid = useRef<string | null>(null);
  const recordRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!hasTake) return;
    const take = takeForEditor();
    if (!take) return;
    const { steps, uid } = insertRecording(draft.steps, take, lastStepUid.current);
    setDraft((d) => ({ ...d, steps }));
    setRecorded({ take, uid });
  }, [hasTake, takeForEditor, draft.steps]);

  useConnectionIdChanges((remap) => {
    setBase((b) => {
      const triggers = remapTriggerConnections(b.triggers, remap);
      return triggers === b.triggers ? b : { ...b, triggers };
    });
    setInitial((d) => remapDraftTriggers(d, remap));
    setDraft((d) => remapDraftTriggers(d, remap));
  });

  const allErrors = useMemo(() => draftErrors(draft), [draft]);
  const values = useMemo(() => draftValues(draft), [draft]);
  const { shown: errors, rootProps, revealAndFocus } = useRevealOnSave(allErrors, values);
  const dirty = scheduleAfterSave || draftContentKey(draft) !== draftContentKey(initial);
  const canSave = Object.keys(allErrors).length === 0;

  const patch = (change: Partial<AutomationDraft>) => setDraft((d) => ({ ...d, ...change }));
  const keysOnly = onlyTypesKeys(draft.steps) || draft.steps.length === 0;
  const showValues = draft.parameters.length > 0 || valuesOpen || !keysOnly;

  const stepEditor: StepEditorContextValue = useMemo(
    () => ({
      automations: automations.filter((a) => a.id !== automation.id),
      errors,
      expanded,
      setExpanded: (uid, open) => setExpandedSet((prev) => toggled(prev, uid, open)),
      failureOpen,
      showFailure: (uid) => setFailureOpen((prev) => toggled(prev, uid, true)),
      announce: setAnnouncement,
      renderStepList: (props) => <StepList {...props} />,
    }),
    [automations, automation.id, errors, expanded, failureOpen]
  );

  /** Open whatever hides an error, then show every error and focus the first. */
  const revealErrors = () => {
    flushSync(() => {
      const steps = stepsWithErrors(draft, allErrors);
      setExpandedSet((prev) => new Set([...prev, ...steps]));
      if (Object.keys(allErrors).some((path) => path.startsWith("triggers."))) setWhenOpen(true);
    });
    if (revealAndFocus()) return;
    // No field is invalid: the step list is empty. Offer "Add step".
    rootProps.ref.current
      ?.querySelector<HTMLElement>('[data-testid="automation-editor-add-step"]')
      ?.focus();
  };

  // Save stays reachable while invalid (aria-disabled, not disabled): using it
  // then points at the problem instead of saving (#5917).
  const handleSave = (run: boolean) => {
    if (!canSave) {
      revealErrors();
      return;
    }
    // An untouched automation is not written again: its file keeps its bytes.
    const changed = isNew || draftContentKey(draft) !== draftContentKey(initial);
    return onSave({
      automation: changed ? fromDraft(draft, base) : null,
      run,
      schedule: scheduleAfterSave,
    });
  };

  // Enter in Name, Description or Tags runs the primary action (#5755). The
  // fields of steps, triggers and values are list rows with Enter rules of their
  // own: Enter after typing a command must not run an unfinished automation.
  const handleKeyDown = useEditorKeyboard({
    onSubmit: () => primaryRef.current?.click(),
    onCancel: () => undefined,
    exemptSelector: "[data-enter-exempt]",
  });

  const saveAndRunIsPrimary = isNew;
  const saveButton = (
    <Button
      ref={saveAndRunIsPrimary ? undefined : primaryRef}
      variant={saveAndRunIsPrimary ? "secondary" : "primary"}
      onClick={() => handleSave(false)}
      aria-disabled={!canSave}
      data-invalid={!canSave || undefined}
      errorToast={false}
      data-testid="automation-editor-save"
    >
      Save
    </Button>
  );
  const saveAndRunButton = (
    <Button
      ref={saveAndRunIsPrimary ? primaryRef : undefined}
      variant={saveAndRunIsPrimary ? "primary" : "secondary"}
      onClick={() => handleSave(true)}
      aria-disabled={!canSave}
      data-invalid={!canSave || undefined}
      errorToast={false}
      data-testid="automation-editor-save-run"
    >
      Save and run
    </Button>
  );

  const handleRecord = (tabId: string) => {
    if (!startRecording({ tabId, intoEditor: draft.name.trim() })) return;
    setRecorded(null);
    showTerminal(tabId);
  };

  const storeSecrets = () => {
    if (!recorded) return;
    patch({ steps: withRecordedSecrets(draft.steps, recorded.take, recorded.uid) });
    setRecorded({ ...recorded, take: { ...recorded.take, secrets: [] } });
  };

  const stepUids = allUids(draft.steps);
  const allExpanded = stepUids.length > 0 && stepUids.every((uid) => expanded.has(uid));

  // Not rendered while recording, rather than closed: the focus is free at once.
  if (recordingHere) return null;

  return (
    <Modal
      open
      // Back from a recording, start where it was asked for.
      initialFocusRef={recorded ? recordRef : undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      dirty={dirty}
      title={isNew ? "New automation" : "Edit automation"}
      description="Name the automation and list what it does, step by step"
      size="lg"
      data-testid="automation-editor-dialog"
      footer={
        <>
          {/* Routed through the Modal so a dirty form asks first (UX2-004). */}
          <ModalClose>
            <Button variant="secondary" data-testid="automation-editor-cancel">
              Cancel
            </Button>
          </ModalClose>
          {/* One primary per footer, on the right (copy style guide). */}
          {!saveAndRunIsPrimary && saveAndRunButton}
          {saveButton}
          {saveAndRunIsPrimary && saveAndRunButton}
        </>
      }
    >
      {/* One scroll container: the Modal body (#5637). */}
      <div
        className="automation-editor"
        data-testid="automation-editor-form"
        onKeyDown={handleKeyDown}
        {...rootProps}
      >
        <div className="automation-editor__head">
          <Field label="Name" htmlFor="automation-editor-name" error={errors.name}>
            <Input
              id="automation-editor-name"
              value={draft.name}
              error={Boolean(errors.name)}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="Automation name"
              data-testid="automation-editor-name"
            />
          </Field>
          <Field label="Description (optional)" htmlFor="automation-editor-description">
            <Input
              id="automation-editor-description"
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="What it does"
              maxLength={ITEM_DESCRIPTION_MAX_LENGTH}
              data-testid="automation-editor-description"
            />
          </Field>
        </div>

        <section
          className="automation-editor__section"
          aria-labelledby="automation-editor-steps-title"
          data-enter-exempt
          onFocusCapture={(e) => {
            lastStepUid.current = outermostStep(e.target) ?? lastStepUid.current;
          }}
        >
          <div className="automation-editor__steps-header">
            <h3 id="automation-editor-steps-title" className="automation-editor__section-title">
              Steps ({draft.steps.length})
            </h3>
            <span className="automation-editor__steps-spacer" />
            <RecordStepsButton ref={recordRef} onRecord={handleRecord} />
            {draft.steps.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpandedSet(new Set(allExpanded ? [] : stepUids))}
                data-testid="automation-editor-steps-toggle-all"
              >
                {allExpanded ? "Collapse all" : "Expand all"}
              </Button>
            )}
          </div>
          {draft.steps.length === 0 && (
            <p
              className={
                errors[STEP_LIST_ERROR]
                  ? "automation-editor__no-steps automation-editor__no-steps--error"
                  : "automation-editor__no-steps"
              }
              role={errors[STEP_LIST_ERROR] ? "alert" : undefined}
              data-testid="automation-editor-no-steps"
            >
              {errors[STEP_LIST_ERROR] ?? "No steps yet. Add the first one."}
            </p>
          )}
          {recorded && (
            <p
              className="automation-editor__recorded"
              role="status"
              data-testid="automation-editor-recorded"
            >
              {recordedNote(recorded.take)}
              {recorded.take.secrets.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={storeSecrets}
                  data-testid="automation-editor-recorded-keep-secrets"
                >
                  Store it unencrypted
                </Button>
              )}
            </p>
          )}
          <StepEditorProvider value={stepEditor}>
            <StepList steps={draft.steps} onChange={(steps) => patch({ steps })} />
          </StepEditorProvider>
        </section>

        <div data-enter-exempt>
          <EditorSection
            title="When it runs"
            summary={whenItRunsSummary(draft.triggers, isNew ? 0 : scheduleCount)}
            open={whenOpen}
            onOpenChange={setWhenOpen}
            data-testid="automation-editor-when-toggle"
          >
            <WhenItRuns
              triggers={draft.triggers}
              triggersEnabled={draft.triggersEnabled}
              automationId={isNew ? null : automation.id}
              scheduleAfterSave={scheduleAfterSave}
              errors={errors}
              onTriggersChange={(triggers) => patch({ triggers })}
              onTriggersEnabledChange={(triggersEnabled) => patch({ triggersEnabled })}
              onScheduleAfterSaveChange={setScheduleAfterSave}
            />
          </EditorSection>
        </div>

        {showValues && (
          <div data-enter-exempt>
            <EditorSection
              title="Ask for values when it runs"
              summary={draft.parameters.length > 0 ? String(draft.parameters.length) : undefined}
              open={valuesOpen}
              onOpenChange={setValuesOpen}
              data-testid="automation-editor-values-toggle"
            >
              <ParametersEditor
                parameters={draft.parameters}
                onChange={(parameters) => patch({ parameters })}
              />
            </EditorSection>
          </div>
        )}

        <EditorSection
          title="Tags"
          summary={draft.tags.trim() || undefined}
          open={tagsOpen}
          onOpenChange={setTagsOpen}
          data-testid="automation-editor-tags-toggle"
        >
          <Field label="Tags (optional, comma-separated)" htmlFor="automation-editor-tags">
            <Input
              id="automation-editor-tags"
              value={draft.tags}
              onChange={(e) => patch({ tags: e.target.value })}
              placeholder="ops, release"
              data-testid="automation-editor-tags"
            />
          </Field>
        </EditorSection>
        <LiveRegion message={announcement} data-testid="automation-editor-live" />
      </div>
    </Modal>
  );
}
