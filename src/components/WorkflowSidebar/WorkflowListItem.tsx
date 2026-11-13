import type React from "react";
import {
  Play,
  Pencil,
  Copy,
  Download,
  Trash2,
  Zap,
  Square,
  ListChecks,
  CalendarClock,
} from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import type { Workflow } from "@/types/workflow";
import type { WorkflowRunState } from "@/store/appStore";
import { armedDescription, armedTriggers, workflowRowSummary } from "./workflowRowSummary";

/**
 * How long a row stays marked after it is saved from the editor (#5687). The
 * `.workflow-item--just-saved` fade in WorkflowSidebar.css runs for the same time.
 */
export const WORKFLOW_JUST_SAVED_MS = 3000;

interface WorkflowListItemProps {
  workflow: Workflow;
  /** Whether this workflow is the one currently running (shows a stop affordance). */
  running: boolean;
  onRun: (workflowId: string) => void;
  /** Open the "Run on…" multi-terminal picker (PROD-047). */
  onRunOn: (workflowId: string) => void;
  /** Stop every in-flight run of this workflow (cancel-all, #3418). */
  onCancel: () => void;
  /**
   * This workflow's in-flight runs (#3418). With more than one — a concurrent
   * "Run on…" fan-out — the row lists each target's progress with its own stop.
   */
  runs?: WorkflowRunState[];
  /** Stop one target's run by id, leaving its siblings running (#3418). */
  onCancelRun?: (runId: string) => void;
  onEdit: (workflowId: string) => void;
  /** Open the schedule editor for this workflow (PROD-043). */
  onSchedule?: (workflowId: string) => void;
  onDuplicate: (workflowId: string) => void;
  onExport: (workflowId: string) => void;
  onDelete: (workflowId: string) => void;
  /**
   * Resolve a saved connection id to its display name, for the trigger line
   * and the armed indicator (#5635). Unknown ids show as "Unknown connection".
   */
  connectionName?: (connectionId: string) => string | undefined;
  /**
   * The row was just saved from the editor: tint it briefly so the user sees
   * which workflow changed (#5687). Static under reduced motion.
   */
  justSaved?: boolean;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus) for keyboard nav. */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}

/** Fallback resolver when the caller passes none: every id is unknown. */
const noConnectionName = (): undefined => undefined;

/**
 * A single workflow row in the manager sidebar: the name first (it is what users
 * scan and search for, #5519; no leading step-count badge), then a muted line
 * saying how it is launched and what it targets — with an "Armed" marker when a
 * trigger runs it automatically (#5635) — its description and tags, and the
 * Run / Run on… / Edit / Duplicate / Export / Delete actions. Double-click runs the
 * workflow against the active session (matching the macro row's affordance).
 * Composed from the shared list-item shell.
 */
export function WorkflowListItem({
  workflow,
  running,
  onRun,
  onRunOn,
  onCancel,
  runs,
  onCancelRun,
  onEdit,
  onSchedule,
  onDuplicate,
  onExport,
  onDelete,
  connectionName = noConnectionName,
  justSaved = false,
  rowRef,
  rowProps,
}: WorkflowListItemProps) {
  const armed = armedTriggers(workflow).length > 0;

  return (
    <SidebarListItem
      ref={rowRef}
      {...rowProps}
      className={justSaved ? "workflow-item--just-saved" : undefined}
      data-just-saved={justSaved ? "true" : undefined}
      testId={`workflow-item-${workflow.id}`}
      nameTestId={`workflow-name-${workflow.id}`}
      name={workflow.name}
      onDoubleClick={() => onRun(workflow.id)}
      actions={
        <>
          {running ? (
            <Tooltip content={runs && runs.length > 1 ? "Stop all" : "Stop"} side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={runs && runs.length > 1 ? "Stop all" : "Stop"}
                data-testid={`workflow-stop-${workflow.id}`}
                icon={<Square size={12} fill="currentColor" />}
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel();
                }}
              />
            </Tooltip>
          ) : (
            <Tooltip content="Run" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Run"
                data-testid={`workflow-run-${workflow.id}`}
                icon={<Play size={12} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onRun(workflow.id);
                }}
              />
            </Tooltip>
          )}
          <Tooltip content="Run on…" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Run on selected terminals"
              data-testid={`workflow-run-on-${workflow.id}`}
              icon={<ListChecks size={12} />}
              disabled={running}
              onClick={(e) => {
                e.stopPropagation();
                onRunOn(workflow.id);
              }}
            />
          </Tooltip>
          <Tooltip content="Edit" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Edit"
              data-testid={`workflow-edit-${workflow.id}`}
              icon={<Pencil size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(workflow.id);
              }}
            />
          </Tooltip>
          {onSchedule ? (
            <Tooltip content="Schedule…" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Schedule"
                data-testid={`workflow-schedule-${workflow.id}`}
                icon={<CalendarClock size={12} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onSchedule(workflow.id);
                }}
              />
            </Tooltip>
          ) : null}
          <Tooltip content="Duplicate" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Duplicate"
              data-testid={`workflow-duplicate-${workflow.id}`}
              icon={<Copy size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate(workflow.id);
              }}
            />
          </Tooltip>
          <Tooltip content="Export" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Export"
              data-testid={`workflow-export-${workflow.id}`}
              icon={<Download size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onExport(workflow.id);
              }}
            />
          </Tooltip>
          <Tooltip content="Delete" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Delete"
              data-testid={`workflow-delete-${workflow.id}`}
              icon={<Trash2 size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(workflow.id);
              }}
            />
          </Tooltip>
        </>
      }
      details={
        <>
          <span className="workflow-item__summary">
            {armed ? (
              <span
                className="workflow-item__armed"
                role="img"
                aria-label={armedDescription(workflow, connectionName)}
                title={armedDescription(workflow, connectionName)}
                data-testid={`workflow-armed-${workflow.id}`}
              >
                <Zap size={10} aria-hidden="true" />
                <span aria-hidden="true">Armed</span>
              </span>
            ) : null}
            <span
              className="workflow-item__summary-text"
              data-testid={`workflow-summary-${workflow.id}`}
            >
              {workflowRowSummary(workflow, connectionName)}
            </span>
          </span>
          {workflow.description ? (
            <span className="workflow-item__description">{workflow.description}</span>
          ) : null}
          {runs && runs.length > 1 ? (
            <ul
              className="workflow-item__targets"
              aria-label="Running terminals"
              data-testid={`workflow-targets-${workflow.id}`}
            >
              {runs.map((run) => (
                <li
                  key={run.runId}
                  className="workflow-item__target"
                  data-testid={`workflow-target-${run.runId}`}
                >
                  <span className="workflow-item__target-name">{run.label || run.tabId}</span>
                  <span className="workflow-item__target-progress">
                    {run.completed} / {run.total}
                  </span>
                  {onCancelRun ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Stop on ${run.label || run.tabId}`}
                      data-testid={`workflow-target-stop-${run.runId}`}
                      icon={<Square size={10} fill="currentColor" />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelRun(run.runId);
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {workflow.tags.length > 0 ? (
            <span className="workflow-item__meta">
              <span className="workflow-item__tags" data-testid={`workflow-tags-${workflow.id}`}>
                {workflow.tags.map((tag) => (
                  <span className="workflow-item__tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </span>
            </span>
          ) : null}
        </>
      }
    />
  );
}
