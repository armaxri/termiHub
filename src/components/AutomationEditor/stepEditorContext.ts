import { createContext, useContext } from "react";
import type React from "react";
import type { ZodFieldErrors } from "@/hooks/useZodEditorForm";
import type { Automation } from "@/types/generated/Automation";
import type { StepDraft, StepListName } from "./automationDraft";

/** Which list this is: the automation's own steps, or one inside a step. */
export interface NestedStepList {
  /** Path of the step it sits in (`0`, `2-then-1`). */
  parent: string;
  list: StepListName;
  /** Its heading ("Then", "Do"). */
  label: string;
}

/** Props of a step list (`StepList`). */
export interface StepListProps {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  /** Absent for the automation's own steps. */
  nested?: NestedStepList;
}

/** What every step row and nested step list of the open editor shares. */
export interface StepEditorContextValue {
  /** The automations a "Run automation" step can run (never the edited one). */
  automations: readonly Automation[];
  /** The validation errors the user should see now, by draft path. */
  errors: ZodFieldErrors;
  /** Uids of the steps whose detail editor is open. */
  expanded: ReadonlySet<string>;
  /** Open (`true`) or close a step's detail editor. */
  setExpanded: (uid: string, open: boolean) => void;
  /** Uids of the steps whose "If this step fails" options were asked for. */
  failureOpen: ReadonlySet<string>;
  /** Show a step's "If this step fails" options. */
  showFailure: (uid: string) => void;
  /** Step aside for the settings; the editor keeps its draft (A-031). */
  openSettings: () => void;
  /** Tell a screen reader what a reorder or a delete just did. */
  announce: (message: string) => void;
  /**
   * Render a nested step list. A step that holds steps renders them through
   * this, so its fields do not import the list that renders them.
   */
  renderStepList: (props: StepListProps) => React.ReactNode;
}

const StepEditorContext = createContext<StepEditorContextValue | null>(null);

/** Provides {@link StepEditorContextValue} to the step lists of one editor. */
export const StepEditorProvider = StepEditorContext.Provider;

/** The open editor's shared step state. */
export function useStepEditor(): StepEditorContextValue {
  const value = useContext(StepEditorContext);
  if (!value) throw new Error("useStepEditor must be used inside StepEditorProvider");
  return value;
}
