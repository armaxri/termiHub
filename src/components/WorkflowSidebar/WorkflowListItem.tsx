import type React from "react";
import { Play, Pencil, Copy, Download, Trash2, Zap, Square } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import type { Workflow } from "@/types/workflow";
import { summariseWorkflowSteps } from "./workflowStepMeta";

interface WorkflowListItemProps {
  workflow: Workflow;
  /** Whether this workflow is the one currently running (shows a stop affordance). */
  running: boolean;
  onRun: (workflowId: string) => void;
  onCancel: () => void;
  onEdit: (workflowId: string) => void;
  onDuplicate: (workflowId: string) => void;
  onExport: (workflowId: string) => void;
  onDelete: (workflowId: string) => void;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus) for keyboard nav. */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}

/** True when the workflow has an on-connect trigger bound to at least one connection. */
function hasOnConnectTrigger(workflow: Workflow): boolean {
  return workflow.triggers.some((t) => t.kind === "on-connect" && t.connectionIds.length > 0);
}

/**
 * A single workflow row in the manager sidebar: name, a step-count badge, an
 * optional on-connect marker, a one-line preview of the step kinds, and the
 * Run / Edit / Duplicate / Export / Delete actions. Double-click runs the
 * workflow against the active session (matching the macro row's affordance).
 * Composed from the shared list-item shell.
 */
export function WorkflowListItem({
  workflow,
  running,
  onRun,
  onCancel,
  onEdit,
  onDuplicate,
  onExport,
  onDelete,
  rowRef,
  rowProps,
}: WorkflowListItemProps) {
  const stepCount = workflow.steps.length;
  const preview = summariseWorkflowSteps(workflow.steps);
  const onConnect = hasOnConnectTrigger(workflow);

  return (
    <SidebarListItem
      ref={rowRef}
      {...rowProps}
      testId={`workflow-item-${workflow.id}`}
      nameTestId={`workflow-name-${workflow.id}`}
      name={workflow.name}
      badge={`${stepCount} step${stepCount === 1 ? "" : "s"}`}
      badgeTestId={`workflow-steps-${workflow.id}`}
      onDoubleClick={() => onRun(workflow.id)}
      actions={
        <>
          {running ? (
            <Tooltip content="Stop" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Stop"
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
          {workflow.description ? (
            <span className="workflow-item__description">{workflow.description}</span>
          ) : null}
          {preview ? (
            <code className="workflow-item__preview" data-testid={`workflow-preview-${workflow.id}`}>
              {preview}
            </code>
          ) : null}
          <span className="workflow-item__meta">
            {onConnect ? (
              <span className="workflow-item__trigger" data-testid={`workflow-on-connect-${workflow.id}`}>
                <Zap size={10} aria-hidden="true" /> on-connect
              </span>
            ) : null}
            {workflow.tags.length > 0 ? (
              <span className="workflow-item__tags" data-testid={`workflow-tags-${workflow.id}`}>
                {workflow.tags.map((tag) => (
                  <span className="workflow-item__tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        </>
      }
    />
  );
}
