import { useCallback, useState } from "react";
import { AutomationEditorDialog, type AutomationSaveRequest } from "@/components/AutomationEditor";
import { toast } from "@/components/ui";
import { newId } from "@/services/transport/ids";
import { useAppStore } from "@/store/appStore";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { errorMessage } from "@/utils/errorMessage";

/** A new automation that is not stored yet; the backend stamps its timestamps. */
function blankAutomation(steps: AutomationStep[]): Automation {
  return {
    id: newId("automation"),
    name: "",
    tags: [],
    steps,
    triggers: [],
    createdAt: "",
    updatedAt: "",
  };
}

/** The automation the editor is open on. */
interface Editing {
  automation: Automation;
  isNew: boolean;
}

/** Result of {@link useAutomationEditors}. */
export interface AutomationEditors {
  /** Create an automation step by step. */
  newFromSteps: () => void;
  /** Create an automation by writing the keystrokes it types. */
  newFromKeys: () => void;
  /** Create an automation that runs `automationId` as its first step. */
  newFromAutomation: (automationId: string) => void;
  /** Edit a stored automation. */
  edit: (automationId: string) => void;
  /** The editor dialog, to render once. */
  dialogs: React.ReactNode;
}

/** Options of {@link useAutomationEditors}. */
export interface AutomationEditorsOptions {
  /** An automation was saved: mark its row. */
  onSaved: (automationId: string) => void;
  /** "Save and run": run it as its row's Run does. */
  onRun: (automationId: string) => void;
}

/** The sidebar's side of the one automation editor (#5818, slice 7). */
export function useAutomationEditors({
  onSaved,
  onRun,
}: AutomationEditorsOptions): AutomationEditors {
  const automations = useAppStore((s) => s.automations);
  const saveAutomation = useAppStore((s) => s.saveAutomationToBackend);
  const openScheduleEditor = useAppStore((s) => s.openScheduleEditor);
  const [editing, setEditing] = useState<Editing | null>(null);

  const create = useCallback(
    (automation: Automation) => setEditing({ automation, isNew: true }),
    []
  );
  const newFromSteps = useCallback(() => create(blankAutomation([])), [create]);
  const newFromKeys = useCallback(
    () => create(blankAutomation([{ kind: "type-keys", chunks: [], timing: "recorded" }])),
    [create]
  );

  const newFromAutomation = useCallback(
    (automationId: string) => {
      const source = automations.find((a) => a.id === automationId);
      if (!source) return;
      const blank = blankAutomation([{ kind: "run-automation", automationId: source.id }]);
      const automation = { ...blank, name: source.name, tags: source.tags };
      if (source.description !== undefined) automation.description = source.description;
      create(automation);
    },
    [automations, create]
  );

  const edit = useCallback(
    (automationId: string) => {
      const automation = automations.find((a) => a.id === automationId);
      if (automation) setEditing({ automation, isNew: false });
    },
    [automations]
  );

  const save = useCallback(
    async ({ automation, run, schedule }: AutomationSaveRequest) => {
      if (!editing) return;
      const { id } = editing.automation;
      if (automation) {
        try {
          await saveAutomation(automation);
        } catch (err) {
          // Keep the dialog open so the edits are not lost on a failed save.
          toast.error(`Failed to save automation: ${errorMessage(err)}`);
          throw err;
        }
      }
      setEditing(null);
      if (automation) onSaved(id);
      if (run) onRun(id);
      if (schedule) openScheduleEditor({ action: { kind: "automation", automationId: id } });
    },
    [editing, saveAutomation, openScheduleEditor, onSaved, onRun]
  );

  const dialogs = editing ? (
    <AutomationEditorDialog
      key={editing.automation.id}
      automation={editing.automation}
      isNew={editing.isNew}
      onClose={() => setEditing(null)}
      onSave={save}
    />
  ) : null;

  return { newFromSteps, newFromKeys, newFromAutomation, edit, dialogs };
}
