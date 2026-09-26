import { useCallback, useState } from "react";
import { Plus, ChevronDown, Play } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { collectLiveTabs, getActiveTab, useAppStore } from "@/store/appStore";
import { currentBroadcastView } from "@/store/broadcastBridge";
import { resolveConnectedTargets, type RunnableTarget } from "@/store/slices/workflowFanout";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useProjectedWorkflowRun } from "@/store/useProjectedWorkflowRun";
import { Button, SearchInput, toast } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { ExportImportButtons } from "@/components/Sidebar/ExportImportButtons";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { useListFilter, nameDescriptionTagsMatcher } from "@/hooks/useListFilter";
import { useJsonFileExport, useJsonFileImport } from "@/hooks/useJsonFile";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import { serializeWorkflows } from "@/services/workflowIo";
import type { Workflow } from "@/types/workflow";
import { WorkflowListItem } from "./WorkflowListItem";
import { WorkflowHistorySection } from "./WorkflowHistorySection";
import { WorkflowRunOutput } from "./WorkflowRunOutput";
import { WorkflowEditorDialog, type WorkflowEditorResult } from "./WorkflowEditorDialog";
import { WorkflowRunTargetsDialog } from "./WorkflowRunTargetsDialog";
import { newId } from "@/services/transport/ids";
import { slugify } from "@/utils/slugify";
import "./WorkflowSidebar.css";
import { errorMessage } from "@/utils/errorMessage";

/** Generate a unique workflow id for a new or duplicated workflow. */
function generateWorkflowId(): string {
  return newId("workflow");
}

/** The open "Run on…" picker (PROD-047): its workflow and a snapshot of targets. */
interface RunTargetsState {
  workflow: Workflow;
  candidates: RunnableTarget[];
  broadcastTabIds: string[];
  initialSelection: string[];
}

/** Stable empty props for the closed picker (avoids re-seeding on every render). */
const NO_TARGETS: RunnableTarget[] = [];
const NO_IDS: string[] = [];

/** Build a fresh, empty workflow draft (backend stamps the timestamps on save). */
function blankWorkflow(): Workflow {
  return {
    id: generateWorkflowId(),
    name: "New workflow",
    tags: [],
    steps: [],
    triggers: [{ kind: "manual" }],
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * The Workflow Manager panel: browse, search, edit, delete and run stored
 * workflows. Workflows are authored (not recorded) ordered step lists run
 * against the active terminal session; this panel is their home for
 * organisation. Composed from the shared UI primitives and the sidebar
 * list-item shell, mirroring the shipped `MacroSidebar`. Workflows can also be
 * exported to / imported from portable JSON, and a macro can be "promoted" into
 * a new single-step workflow. The search, export/import, and delete-confirm
 * flows come from the shared sidebar hooks (UISF-020).
 */
export function WorkflowSidebar() {
  const workflows = useAppStore((s) => s.workflows);
  const macros = useAppStore((s) => s.macros);
  const { connections } = useProjectedConnections();
  const saveWorkflowToBackend = useAppStore((s) => s.saveWorkflowToBackend);
  const deleteWorkflowFromBackend = useAppStore((s) => s.deleteWorkflowFromBackend);
  const importWorkflows = useAppStore((s) => s.importWorkflows);
  const runWorkflow = useAppStore((s) => s.runWorkflow);
  const cancelWorkflowRun = useAppStore((s) => s.cancelWorkflowRun);
  const cancelAllWorkflowRuns = useCallback(() => cancelWorkflowRun(), [cancelWorkflowRun]);
  // The per-workflow "running" badge reads run progress from the authoritative
  // projected `workflow-run` region (#2206 reducer-removal).
  // Several runs may be in flight at once — a concurrent fan-out (#3418).
  const { workflowRuns } = useProjectedWorkflowRun();

  // The workflow being edited: an existing one (isNew=false) or a fresh draft.
  const [editing, setEditing] = useState<{ workflow: Workflow; isNew: boolean } | null>(null);
  const [runTargets, setRunTargets] = useState<RunTargetsState | null>(null);
  const { query, setQuery, filtered } = useListFilter(workflows, nameDescriptionTagsMatcher);
  const exportWorkflowsToFile = useJsonFileExport("workflows");
  const importWorkflowsFromFile = useJsonFileImport("workflows");
  const workflowDelete = useDeleteConfirm<{ id: string; name: string }>(async ({ id, name }) => {
    try {
      await deleteWorkflowFromBackend(id);
      toast.success(`Deleted workflow "${name}"`);
    } catch (err) {
      const message = errorMessage(err);
      toast.error(`Failed to delete workflow: ${message}`);
    }
  });
  const requestDelete = workflowDelete.request;

  const handleNew = useCallback(() => {
    setEditing({ workflow: blankWorkflow(), isNew: true });
  }, []);

  const handlePromoteMacro = useCallback(
    (macroId: string) => {
      const macro = macros.find((m) => m.id === macroId);
      if (!macro) return;
      setEditing({
        workflow: {
          ...blankWorkflow(),
          name: macro.name,
          description: macro.description,
          tags: macro.tags,
          steps: [{ kind: "run-macro", macroId: macro.id }],
        },
        isNew: true,
      });
    },
    [macros]
  );

  const handleRun = useCallback(
    (workflowId: string) => {
      void runWorkflow(workflowId);
    },
    [runWorkflow]
  );

  const openRunTargets = useCallback(
    (workflowId: string) => {
      const workflow = workflows.find((w) => w.id === workflowId);
      if (!workflow) return;
      // Snapshot the connected terminals and broadcast group at open time.
      const state = useAppStore.getState();
      const { targets } = resolveConnectedTargets(
        state,
        collectLiveTabs(state).map((t) => t.id)
      );
      const broadcast = currentBroadcastView();
      const broadcastTabIds = broadcast.active ? broadcast.targetTabIds : [];
      const activeId = getActiveTab(state)?.id;
      const preferred = broadcastTabIds.length > 0 ? broadcastTabIds : activeId ? [activeId] : [];
      setRunTargets({
        workflow,
        candidates: targets,
        broadcastTabIds,
        initialSelection: targets.filter((t) => preferred.includes(t.id)).map((t) => t.id),
      });
    },
    [workflows]
  );

  const handleEdit = useCallback(
    (workflowId: string) => {
      const workflow = workflows.find((w) => w.id === workflowId);
      if (workflow) setEditing({ workflow, isNew: false });
    },
    [workflows]
  );

  const handleDuplicate = useCallback(
    async (workflowId: string) => {
      const original = workflows.find((w) => w.id === workflowId);
      if (!original) return;
      const duplicate: Workflow = {
        ...original,
        id: generateWorkflowId(),
        name: `Copy of ${original.name}`,
        steps: original.steps.map((s) => ({ ...s })),
        triggers: original.triggers.map((t) => ({ ...t })),
        createdAt: "",
        updatedAt: "",
      };
      try {
        await saveWorkflowToBackend(duplicate);
        toast.success(`Duplicated "${original.name}"`);
      } catch (err) {
        const message = errorMessage(err);
        toast.error(`Failed to duplicate "${original.name}"`, { description: message });
      }
    },
    [workflows, saveWorkflowToBackend]
  );

  const handleExportAll = useCallback(() => {
    void exportWorkflowsToFile({
      defaultPath: "termihub-workflows.json",
      content: () => serializeWorkflows(workflows),
      successMessage: `Exported ${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`,
    });
  }, [workflows, exportWorkflowsToFile]);

  const handleExportOne = useCallback(
    (workflowId: string) => {
      const workflow = workflows.find((w) => w.id === workflowId);
      if (!workflow) return;
      void exportWorkflowsToFile({
        defaultPath: `termihub-workflow-${slugify(workflow.name, "workflow")}.json`,
        content: () => serializeWorkflows([workflow]),
        successMessage: `Exported "${workflow.name}"`,
      });
    },
    [workflows, exportWorkflowsToFile]
  );

  const handleImport = useCallback(() => {
    void importWorkflowsFromFile(async (json) => {
      const result = await importWorkflows(json);
      const summary = `Imported ${result.imported} workflow${result.imported === 1 ? "" : "s"}`;
      if (result.localProcessSteps > 0) {
        // Security surfacing (#1856): an imported workflow may carry a
        // run-local-process step. It is preserved but NOT auto-authorized — the
        // runner refuses to spawn it until it is explicitly enabled (#1857). Flag
        // it prominently (persistent toast) so it is never silently trusted.
        const stepLabel = `${result.localProcessSteps} local-process step${
          result.localProcessSteps === 1 ? "" : "s"
        }`;
        const wfLabel = `${result.workflowsWithLocalProcess} imported workflow${
          result.workflowsWithLocalProcess === 1 ? "" : "s"
        }`;
        toast.success(summary, {
          description: `${wfLabel} contain ${stepLabel} that run a local program. These stay disabled and will not run until you review and authorize them.`,
          duration: Infinity,
        });
      } else {
        toast.success(summary);
      }
    });
  }, [importWorkflows, importWorkflowsFromFile]);

  const handleDelete = useCallback(
    (workflowId: string) => {
      const workflow = workflows.find((w) => w.id === workflowId);
      if (!workflow) return;
      requestDelete({ id: workflow.id, name: workflow.name });
    },
    [workflows, requestDelete]
  );

  const handleSaveEdit = useCallback(
    async (result: WorkflowEditorResult) => {
      if (!editing) return;
      const updated: Workflow = {
        ...editing.workflow,
        name: result.name,
        description: result.description,
        tags: result.tags,
        steps: result.steps,
        triggers: result.triggers,
        // Omit the key entirely when there are no parameters, so a
        // parameter-free workflow serialises byte-identically (PROD-0040).
        parameters: result.parameters.length > 0 ? result.parameters : undefined,
      };
      try {
        await saveWorkflowToBackend(updated);
        setEditing(null);
        toast.success(`Saved workflow "${result.name}"`);
      } catch (err) {
        // Keep the dialog open so the edits are not lost on a failed save.
        const message = errorMessage(err);
        toast.error(`Failed to save workflow: ${message}`);
        throw err;
      }
    },
    [editing, saveWorkflowToBackend]
  );

  // Roving-tabindex keyboard navigation over the filtered list, matching the
  // other management sidebars. Enter runs the focused workflow.
  const handleActivate = useCallback((workflow: Workflow) => handleRun(workflow.id), [handleRun]);
  const nav = useFlatRovingNav<Workflow, HTMLDivElement>(
    filtered,
    (workflow) => workflow.name,
    handleActivate
  );

  return (
    <div className="workflow-sidebar" data-testid="workflow-sidebar">
      <SidebarToolbar align="center">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus size={12} />}
              aria-label="New Workflow"
              data-testid="workflow-new-btn"
            >
              New
              <ChevronDown size={12} />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="settings-menu__content" align="start" sideOffset={4}>
              <DropdownMenu.Item
                className="settings-menu__item"
                onSelect={handleNew}
                data-testid="workflow-new-blank"
              >
                <Plus size={14} />
                Blank workflow
              </DropdownMenu.Item>
              {macros.length > 0 ? (
                <>
                  <DropdownMenu.Separator className="settings-menu__separator" />
                  <DropdownMenu.Label className="settings-menu__label">
                    Promote a macro
                  </DropdownMenu.Label>
                  {macros.map((macro) => (
                    <DropdownMenu.Item
                      key={macro.id}
                      className="settings-menu__item"
                      onSelect={() => handlePromoteMacro(macro.id)}
                      data-testid={`workflow-promote-macro-${macro.id}`}
                    >
                      <Play size={14} />
                      {macro.name}
                    </DropdownMenu.Item>
                  ))}
                </>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <ExportImportButtons
          onExport={handleExportAll}
          onImport={handleImport}
          exportLabel="Export All Workflows"
          importLabel="Import Workflows"
          exportDisabled={workflows.length === 0}
          exportTestId="workflow-export-all-btn"
          importTestId="workflow-import-btn"
        />
      </SidebarToolbar>
      <div className="workflow-sidebar__search">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search workflows"
          aria-label="Search workflows"
          clearLabel="Clear workflow search"
          data-testid="workflow-search"
        />
      </div>
      {workflows.length === 0 ? (
        <div className="workflow-sidebar__empty" data-testid="workflow-empty-message">
          <span>No workflows yet.</span>
          <span>
            Author one with{" "}
            <button className="workflow-sidebar__empty-link" onClick={handleNew} type="button">
              New workflow
            </button>
            , or promote a macro into a workflow.
          </span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="workflow-sidebar__empty" data-testid="workflow-no-results">
          <span>No workflows match &quot;{query}&quot;.</span>
        </div>
      ) : (
        <div
          className="workflow-sidebar__list"
          data-testid="workflow-list"
          role="tree"
          aria-label="Workflows"
          onKeyDown={nav.onKeyDown}
        >
          {filtered.map((workflow, index) => {
            const { ref, ...itemProps } = nav.getItemProps(index);
            return (
              <WorkflowListItem
                key={workflow.id}
                workflow={workflow}
                running={workflowRuns.some((r) => r.workflowId === workflow.id)}
                runs={workflowRuns.filter((r) => r.workflowId === workflow.id)}
                onCancelRun={cancelWorkflowRun}
                onRun={handleRun}
                onRunOn={openRunTargets}
                onCancel={cancelAllWorkflowRuns}
                onEdit={handleEdit}
                onDuplicate={handleDuplicate}
                onExport={handleExportOne}
                onDelete={handleDelete}
                rowRef={ref}
                rowProps={itemProps}
              />
            );
          })}
        </div>
      )}
      <WorkflowHistorySection />
      <WorkflowRunOutput />
      <WorkflowEditorDialog
        open={editing !== null}
        workflow={editing?.workflow ?? null}
        isNew={editing?.isNew ?? false}
        macros={macros}
        connections={connections}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSave={handleSaveEdit}
      />
      <WorkflowRunTargetsDialog
        open={runTargets !== null}
        workflowName={runTargets?.workflow.name ?? ""}
        candidates={runTargets?.candidates ?? NO_TARGETS}
        broadcastTabIds={runTargets?.broadcastTabIds ?? NO_IDS}
        initialSelection={runTargets?.initialSelection ?? NO_IDS}
        onOpenChange={(open) => {
          if (!open) setRunTargets(null);
        }}
        onRun={(tabIds, { parallel }) => {
          if (runTargets) {
            void runWorkflow(runTargets.workflow.id, {
              targetTabIds: tabIds,
              ...(parallel ? {} : { concurrency: 1 }),
            });
          }
        }}
      />
      <ConfirmDeleteDialog
        {...workflowDelete.dialogProps}
        message={
          workflowDelete.pending
            ? `Delete workflow "${workflowDelete.pending.name}"? This cannot be undone.`
            : ""
        }
      />
    </div>
  );
}
