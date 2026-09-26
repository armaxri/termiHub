import { useEffect, useState } from "react";
import { Modal, Button, Checkbox } from "@/components/ui";
import type { RunnableTarget } from "@/store/slices/workflowFanout";
import "./WorkflowRunTargetsDialog.css";

/** Props for {@link WorkflowRunTargetsDialog}. */
export interface WorkflowRunTargetsDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The workflow about to run, for the dialog copy. */
  workflowName: string;
  /** Connected terminals the workflow can run on, in display order. */
  candidates: RunnableTarget[];
  /** Tab ids of the active broadcast group (empty when broadcast is off). */
  broadcastTabIds: string[];
  /** The selection the dialog opens with. */
  initialSelection: string[];
  /** Called when the dialog should open/close. */
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen tab ids (in display order) when the user runs. */
  onRun: (tabIds: string[]) => void;
}

/**
 * "Run on…" picker for a manual multi-target workflow run (PROD-047): a
 * checkbox per connected terminal, shortcuts to select all or the active
 * broadcast group, and a Run button that is disabled until at least one
 * terminal is chosen. The workflow then runs on each chosen terminal in turn.
 */
export function WorkflowRunTargetsDialog({
  open,
  workflowName,
  candidates,
  broadcastTabIds,
  initialSelection,
  onOpenChange,
  onRun,
}: WorkflowRunTargetsDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Re-seed the selection each time the dialog opens so a prior pick never leaks in.
  useEffect(() => {
    if (open) setSelected(new Set(initialSelection));
  }, [open, initialSelection]);

  const broadcastCandidates = candidates.filter((c) => broadcastTabIds.includes(c.id));

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleRun = () => {
    const ids = candidates.filter((c) => selected.has(c.id)).map((c) => c.id);
    if (ids.length === 0) return;
    onRun(ids);
    onOpenChange(false);
  };

  const count = candidates.filter((c) => selected.has(c.id)).length;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Run "${workflowName}" on…`}
      description="Choose the terminals to run the workflow on. They run one after another."
      data-testid="workflow-run-targets-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="workflow-run-targets-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleRun}
            disabled={count === 0}
            data-testid="workflow-run-targets-run"
          >
            {count > 1 ? `Run on ${count} terminals` : "Run"}
          </Button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="workflow-run-targets__empty" role="status">
          No connected terminals. Open a terminal session to run the workflow on it.
        </p>
      ) : (
        <>
          <div className="workflow-run-targets__shortcuts">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set(candidates.map((c) => c.id)))}
              data-testid="workflow-run-targets-all"
            >
              Select all
            </Button>
            {broadcastCandidates.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Set(broadcastCandidates.map((c) => c.id)))}
                data-testid="workflow-run-targets-broadcast"
              >
                Broadcast group ({broadcastCandidates.length})
              </Button>
            )}
          </div>
          <ul className="workflow-run-targets__list" data-testid="workflow-run-targets-list">
            {candidates.map((c) => (
              <li key={c.id} className="workflow-run-targets__item">
                <Checkbox
                  id={`workflow-run-target-${c.id}`}
                  checked={selected.has(c.id)}
                  onCheckedChange={(checked) => toggle(c.id, checked)}
                  data-testid={`workflow-run-target-${c.id}`}
                />
                <label htmlFor={`workflow-run-target-${c.id}`}>{c.title}</label>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
