import { useEffect, useRef } from "react";
import { Loader2, CheckCircle2, XCircle, Ban, X, Square, Terminal } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, Tooltip } from "@/components/ui";
import type { WorkflowRunOutputState } from "@/store/appStore";
import "./WorkflowRunOutput.css";

/** Human-readable label + icon for each run-output status. */
const STATUS_META: Record<
  WorkflowRunOutputState["status"],
  { label: string; Icon: typeof Loader2; className: string }
> = {
  running: { label: "Running", Icon: Loader2, className: "workflow-run-output--running" },
  completed: { label: "Completed", Icon: CheckCircle2, className: "workflow-run-output--completed" },
  cancelled: { label: "Cancelled", Icon: Ban, className: "workflow-run-output--cancelled" },
  failed: { label: "Failed", Icon: XCircle, className: "workflow-run-output--failed" },
};

/**
 * Describe the process's exit outcome for the surface footer: a timeout, a
 * cancellation, or a concrete exit code. Returns `null` while the process is
 * still running and has not reported anything terminal yet.
 */
function describeOutcome(run: WorkflowRunOutputState): string | null {
  if (run.timedOut) return "Timed out";
  if (run.status === "cancelled") return "Cancelled";
  if (run.exitCode !== null) return `Exit code ${run.exitCode}`;
  if (run.status === "failed") return run.error ?? "Failed";
  return null;
}

/**
 * Inline run-output panel for a `run-local-process` workflow step (#1865).
 *
 * Renders at the foot of the Workflow Manager whenever a run has spawned (or
 * recently spawned) a local process, showing its streamed stdout/stderr as it
 * arrives, a live status indicator, and the final exit outcome — so the user
 * sees a local-process step's output inline in the workflow UI rather than
 * having to open the LogViewer. It consumes the streamed output the store
 * accumulates from #1857's `subscribeLocalProcessOutput` events; it adds no new
 * backend channel. Nothing renders when there is no run output to show.
 */
export function WorkflowRunOutput() {
  const run = useAppStore((s) => s.workflowRunOutput);
  const dismiss = useAppStore((s) => s.dismissWorkflowRunOutput);
  const cancelRun = useAppStore((s) => s.cancelWorkflowRun);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lineCount = run?.lines.length ?? 0;

  // Keep the newest output in view as lines stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lineCount]);

  if (!run) return null;

  const meta = STATUS_META[run.status];
  const outcome = describeOutcome(run);
  const isRunning = run.status === "running";
  const commandLine = [run.program, ...run.args].join(" ");

  return (
    <section
      className={`workflow-run-output ${meta.className}`}
      data-testid="workflow-run-output"
      aria-label="Workflow run output"
    >
      <header className="workflow-run-output__header">
        <span
          className="workflow-run-output__status"
          data-testid="workflow-run-output-status"
          data-status={run.status}
        >
          <meta.Icon
            size={13}
            className={`workflow-run-output__status-icon${
              isRunning ? " workflow-run-output__status-icon--spin" : ""
            }`}
            aria-hidden="true"
          />
          {meta.label}
        </span>
        <span className="workflow-run-output__spacer" />
        {isRunning ? (
          <Tooltip content="Stop" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Stop workflow run"
              data-testid="workflow-run-output-stop"
              icon={<Square size={12} fill="currentColor" />}
              onClick={cancelRun}
            />
          </Tooltip>
        ) : (
          <Tooltip content="Dismiss" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Dismiss run output"
              data-testid="workflow-run-output-dismiss"
              icon={<X size={12} />}
              onClick={dismiss}
            />
          </Tooltip>
        )}
      </header>

      <div className="workflow-run-output__command" data-testid="workflow-run-output-command">
        <Terminal size={11} aria-hidden="true" />
        <code title={commandLine}>{commandLine}</code>
      </div>

      <div
        className="workflow-run-output__stream"
        data-testid="workflow-run-output-stream"
        ref={scrollRef}
        role="log"
        aria-live="polite"
      >
        {lineCount === 0 ? (
          <div className="workflow-run-output__empty" data-testid="workflow-run-output-empty">
            {isRunning ? "Waiting for output…" : "No output"}
          </div>
        ) : (
          run.lines.map((line) => (
            <div
              key={line.id}
              className={`workflow-run-output__line workflow-run-output__line--${line.stream}`}
              data-stream={line.stream}
            >
              {line.text}
            </div>
          ))
        )}
      </div>

      {outcome ? (
        <footer className="workflow-run-output__footer" data-testid="workflow-run-output-outcome">
          {outcome}
        </footer>
      ) : null}
    </section>
  );
}
