import { useCallback, useMemo, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import {
  MacroEditorDialog,
  type MacroEditorResult,
} from "@/components/MacroSidebar/MacroEditorDialog";
import {
  WorkflowEditorDialog,
  type WorkflowEditorResult,
} from "@/components/WorkflowSidebar/WorkflowEditorDialog";
import { newId } from "@/services/transport/ids";
import { isMacroShaped } from "@/store/slices/automationViews";
import type { Macro } from "@/types/macro";
import type { SavedConnection } from "@/types/connection";
import type { Workflow, WorkflowStep } from "@/types/workflow";
import { errorMessage } from "@/utils/errorMessage";

/** A fresh, empty step-by-step draft (the backend stamps the timestamps on save). */
function blankWorkflow(steps: WorkflowStep[] = []): Workflow {
  return {
    id: newId("workflow"),
    name: "New automation",
    tags: [],
    steps,
    triggers: [{ kind: "manual" }],
    createdAt: "",
    updatedAt: "",
  };
}

/** The editor that is open: on typed keystrokes or on steps, new or existing. */
type Editing =
  | { kind: "keys"; macroId: string | null }
  | { kind: "steps"; workflow: Workflow; isNew: boolean };

/** Result of {@link useAutomationEditors}. */
export interface AutomationEditors {
  /** Create an automation step by step. */
  newFromSteps: () => void;
  /** Create an automation by writing the keystrokes it types. */
  newFromKeys: () => void;
  /** Create a step-by-step automation that runs `automationId` as its first step. */
  newFromAutomation: (automationId: string) => void;
  /** Open the editor that fits an automation. */
  edit: (automationId: string) => void;
  /** The editor dialogs, to render once. */
  dialogs: React.ReactNode;
}

/**
 * The sidebar's side of the two editors until slice 7 merges them (#5818): an
 * automation that only types keystrokes opens in the keystroke editor, every
 * other one in the step editor.
 */
export function useAutomationEditors(
  connections: SavedConnection[],
  onSaved: (automationId: string) => void
): AutomationEditors {
  const automations = useAppStore((s) => s.automations);
  const macros = useAppStore((s) => s.macros);
  const workflows = useAppStore((s) => s.workflows);
  const saveMacroToBackend = useAppStore((s) => s.saveMacroToBackend);
  const saveWorkflowToBackend = useAppStore((s) => s.saveWorkflowToBackend);
  const [editing, setEditing] = useState<Editing | null>(null);
  const close = useCallback((open: boolean) => {
    if (!open) setEditing(null);
  }, []);

  const newFromSteps = useCallback(
    () => setEditing({ kind: "steps", workflow: blankWorkflow(), isNew: true }),
    []
  );
  const newFromKeys = useCallback(() => setEditing({ kind: "keys", macroId: null }), []);

  const newFromAutomation = useCallback(
    (automationId: string) => {
      const source = automations.find((a) => a.id === automationId);
      if (!source) return;
      setEditing({
        kind: "steps",
        isNew: true,
        workflow: {
          ...blankWorkflow([{ kind: "run-macro", macroId: source.id }]),
          name: source.name,
          description: source.description,
          tags: source.tags,
        },
      });
    },
    [automations]
  );

  const edit = useCallback(
    (automationId: string) => {
      const automation = automations.find((a) => a.id === automationId);
      if (!automation) return;
      if (isMacroShaped(automation)) {
        setEditing({ kind: "keys", macroId: automationId });
        return;
      }
      const workflow = workflows.find((w) => w.id === automationId);
      if (workflow) setEditing({ kind: "steps", workflow, isNew: false });
    },
    [automations, workflows]
  );

  const editedMacro = useMemo(
    () =>
      editing?.kind === "keys" ? (macros.find((m) => m.id === editing.macroId) ?? null) : null,
    [editing, macros]
  );
  const creatingKeys = editing?.kind === "keys" && editing.macroId === null;

  const saveKeys = useCallback(
    async (result: MacroEditorResult) => {
      const fields = {
        name: result.name,
        description: result.description,
        tags: result.tags,
        steps: result.steps,
      };
      const next: Macro = editedMacro
        ? { ...editedMacro, ...fields }
        : // The backend stamps authoritative created/updated timestamps.
          { id: newId("macro"), ...fields, createdAt: "", updatedAt: "" };
      try {
        await saveMacroToBackend(next);
        setEditing(null);
        onSaved(next.id);
      } catch (err) {
        // Keep the dialog open so the keystrokes are not lost on a failed save.
        toast.error(`Failed to save automation: ${errorMessage(err)}`);
        throw err;
      }
    },
    [editedMacro, saveMacroToBackend, onSaved]
  );

  const saveSteps = useCallback(
    async (result: WorkflowEditorResult) => {
      if (editing?.kind !== "steps") return;
      const updated: Workflow = {
        ...editing.workflow,
        name: result.name,
        description: result.description,
        tags: result.tags,
        steps: result.steps,
        triggers: result.triggers,
        // Omit the key entirely when there are no parameters, so a
        // parameter-free automation serialises byte-identically (PROD-0040).
        parameters: result.parameters.length > 0 ? result.parameters : undefined,
      };
      try {
        await saveWorkflowToBackend(updated);
        setEditing(null);
        onSaved(updated.id);
      } catch (err) {
        // Keep the dialog open so the edits are not lost on a failed save.
        toast.error(`Failed to save automation: ${errorMessage(err)}`);
        throw err;
      }
    },
    [editing, saveWorkflowToBackend, onSaved]
  );

  const dialogs = (
    <>
      <MacroEditorDialog
        open={creatingKeys || editedMacro !== null}
        macro={editedMacro}
        onOpenChange={close}
        onSave={saveKeys}
      />
      <WorkflowEditorDialog
        open={editing?.kind === "steps"}
        workflow={editing?.kind === "steps" ? editing.workflow : null}
        isNew={editing?.kind === "steps" && editing.isNew}
        macros={macros}
        connections={connections}
        onOpenChange={close}
        onSave={saveSteps}
      />
    </>
  );

  return { newFromSteps, newFromKeys, newFromAutomation, edit, dialogs };
}
