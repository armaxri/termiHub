import { useCallback, useEffect } from "react";
import { History, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, StatusDot, Tooltip, toast } from "@/components/ui";
import type { StatusTone } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import type { WorkflowRun, WorkflowRunHistoryStatus } from "@/types/workflow";
import { formatAbsoluteTime, formatElapsed, formatRelativeTime } from "@/utils/formatters";
import { errorMessage } from "@/utils/errorMessage";

/** Map a run's terminal status to a {@link StatusDot} tone. */
function statusTone(status: WorkflowRunHistoryStatus): StatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "warning";
  }
}

/** Human label for a run's terminal status. */
function statusLabel(status: WorkflowRunHistoryStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** The run's duration as a compact, human-readable string (e.g. `2s`, `1m 5s`). */
function runDuration(run: WorkflowRun): string {
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  return formatElapsed(Math.round(ms / 1000));
}

/**
 * The persisted workflow run-history panel (PROD-0046). Lists the most recent
 * runs — status, timing, step progress, and what launched each — beneath the
 * workflow library, with a single "Clear history" action. Metadata only: the
 * runs' terminal output is never stored. Composed from the shared sidebar
 * list-item shell and UI primitives, tokens only. Lives inside
 * {@link "./WorkflowSidebar".WorkflowSidebar}, so it is gated by the same
 * experimental-features flag as the rest of the workflow UI.
 */
export function WorkflowHistorySection() {
  const workflowRuns = useAppStore((s) => s.workflowRuns);
  const loadWorkflowRuns = useAppStore((s) => s.loadWorkflowRuns);
  const clearWorkflowRunHistory = useAppStore((s) => s.clearWorkflowRunHistory);

  useEffect(() => {
    void loadWorkflowRuns();
  }, [loadWorkflowRuns]);

  const handleClear = useCallback(async () => {
    try {
      await clearWorkflowRunHistory();
      toast.success("Cleared workflow run history");
    } catch (err) {
      toast.error(`Failed to clear history: ${errorMessage(err)}`);
    }
  }, [clearWorkflowRunHistory]);

  return (
    <section
      className="workflow-history"
      data-testid="workflow-history"
      aria-label="Workflow run history"
    >
      <header className="workflow-history__header">
        <span className="workflow-history__title">
          <History size={12} aria-hidden="true" /> History
        </span>
        <Tooltip content="Clear history" side="top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Clear history"
            data-testid="workflow-history-clear"
            icon={<Trash2 size={12} />}
            disabled={workflowRuns.length === 0}
            onClick={() => void handleClear()}
          />
        </Tooltip>
      </header>
      {workflowRuns.length === 0 ? (
        <div className="workflow-history__empty" data-testid="workflow-history-empty">
          No runs recorded yet.
        </div>
      ) : (
        <div className="workflow-history__list" data-testid="workflow-history-list">
          {workflowRuns.map((run) => {
            const duration = runDuration(run);
            return (
              <SidebarListItem
                key={run.id}
                testId={`workflow-run-${run.id}`}
                name={run.workflowName}
                status={
                  <StatusDot
                    tone={statusTone(run.status)}
                    label={statusLabel(run.status)}
                    title={statusLabel(run.status)}
                  />
                }
                badge={`${run.stepsCompleted}/${run.total}`}
                actions={null}
                details={
                  <span className="workflow-history__meta">
                    <time dateTime={run.endedAt} title={formatAbsoluteTime(run.endedAt)}>
                      {formatRelativeTime(run.endedAt)}
                    </time>
                    {duration ? <span> · {duration}</span> : null}
                    <span> · {run.triggeredBy}</span>
                    {run.continuedFailures ? (
                      <span data-testid={`workflow-run-tolerated-${run.id}`}>
                        {" "}
                        · {run.continuedFailures} tolerated failure
                        {run.continuedFailures === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </span>
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
