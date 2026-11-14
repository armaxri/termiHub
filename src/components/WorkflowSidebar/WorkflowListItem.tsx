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
import { Button, Toggle, Tooltip } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import type { Workflow } from "@/types/workflow";
import type { WorkflowRunState } from "@/store/appStore";
import { workflowTriggersEnabled } from "@/services/workflowTriggers";
import {
  armedDescription,
  armedTriggers,
  disarmedDescription,
  workflowRowTooltip,
} from "./workflowRowSummary";

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
   * Arm (`true`) or disarm (`false`) the workflow's automatic triggers from its
   * row (#5674). When given, a trigger-armed row shows an on/off switch next to
   * its Armed marker; the trigger bindings are kept either way.
   */
  onSetTriggersEnabled?: (workflowId: string, enabled: boolean) => void;
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
 * scan and search for, #5519; no leading step-count badge), then the user's
 * description when there is one, an "Armed"/"Off" marker (with its switch) when
 * a trigger runs it automatically (#5635, #5674), the per-terminal progress of a
 * running fan-out, and the Run / Run on… / Edit / Duplicate / Export / Delete
 * actions. How it is launched, what it targets and its tags are settings, not
 * names: they live in the name's tooltip (#5757). Double-click runs the
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
  onSetTriggersEnabled,
  connectionName = noConnectionName,
  justSaved = false,
  rowRef,
  rowProps,
}: WorkflowListItemProps) {
  const armed = armedTriggers(workflow).length > 0;
  const enabled = workflowTriggersEnabled(workflow);
  const markerDescription = enabled
    ? armedDescription(workflow, connectionName)
    : disarmedDescription(workflow, connectionName);

  return (
    <SidebarListItem
      ref={rowRef}
      {...rowProps}
      className={justSaved ? "workflow-item--just-saved" : undefined}
      data-just-saved={justSaved ? "true" : undefined}
      testId={`workflow-item-${workflow.id}`}
      nameTestId={`workflow-name-${workflow.id}`}
      name={workflow.name}
      description={workflow.description}
      descriptionTestId={`workflow-description-${workflow.id}`}
      tooltip={workflowRowTooltip(workflow, connectionName)}
      tooltipTestId={`workflow-tooltip-${workflow.id}`}
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
        armed || (runs && runs.length > 1) ? (
          <>
            {armed ? (
              <span className="workflow-item__summary">
                <span
                  className={
                    enabled
                      ? "workflow-item__armed"
                      : "workflow-item__armed workflow-item__armed--off"
                  }
                  role="img"
                  aria-label={markerDescription}
                  title={markerDescription}
                  data-testid={`workflow-armed-${workflow.id}`}
                  data-armed={enabled ? "true" : "false"}
                >
                  <Zap size={10} aria-hidden="true" />
                  <span aria-hidden="true">{enabled ? "Armed" : "Off"}</span>
                </span>
                {onSetTriggersEnabled ? (
                  // Keep the switch's own clicks and Enter/Space off the row: the row
                  // runs on double-click and the list's roving nav claims Enter.
                  <span
                    className="workflow-item__arm-toggle"
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                    }}
                  >
                    <Toggle
                      checked={enabled}
                      onCheckedChange={(next) => onSetTriggersEnabled(workflow.id, next)}
                      aria-label={`${enabled ? "Disarm" : "Arm"} workflow ${workflow.name}`}
                      data-testid={`workflow-arm-toggle-${workflow.id}`}
                    />
                  </span>
                ) : null}
              </span>
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
          </>
        ) : null
      }
    />
  );
}
