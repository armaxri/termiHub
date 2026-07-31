import { useCallback, useMemo, useState } from "react";
import { Plus, Download, Upload, Search, ChevronDown, Play } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import { useProjectedWorkflowRun } from "@/store/useProjectedWorkflowRun";
import { Button, Input, toast, Tooltip } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { serializeWorkflows } from "@/services/workflowIo";
import type { Workflow } from "@/types/workflow";
import { WorkflowListItem } from "./WorkflowListItem";
import { WorkflowRunOutput } from "./WorkflowRunOutput";
import { WorkflowEditorDialog, type WorkflowEditorResult } from "./WorkflowEditorDialog";
import "./WorkflowSidebar.css";

/** Generate a unique workflow id for a new or duplicated workflow. */
function generateWorkflowId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return `workflow-${c.randomUUID()}`;
  }
  return `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Turn a workflow name into a filesystem-friendly slug for the default filename. */
function slugifyWorkflowName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "workflow";
}

/** True when the workflow matches the (already lower-cased) query across name/description/tags. */
function workflowMatches(workflow: Workflow, query: string): boolean {
  if (!query) return true;
  if (workflow.name.toLowerCase().includes(query)) return true;
  if (workflow.description?.toLowerCase().includes(query)) return true;
  return workflow.tags.some((tag) => tag.toLowerCase().includes(query));
}

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
 * a new single-step workflow.
 */
export function WorkflowSidebar() {
  const workflows = useAppStore((s) => s.workflows);
  const macros = useAppStore((s) => s.macros);
  const connections = useAppStore((s) => s.connections);
  const saveWorkflowToBackend = useAppStore((s) => s.saveWorkflowToBackend);
  const deleteWorkflowFromBackend = useAppStore((s) => s.deleteWorkflowFromBackend);
  const importWorkflows = useAppStore((s) => s.importWorkflows);
  const runWorkflow = useAppStore((s) => s.runWorkflow);
  const cancelWorkflowRun = useAppStore((s) => s.cancelWorkflowRun);
  // Render cut (#2243): the per-workflow "running" badge reads run progress from
  // the projected `workflow-run` region when it mirrors appStore, else appStore.
  const { workflowRun } = useProjectedWorkflowRun();

  const [query, setQuery] = useState("");
  // The workflow being edited: an existing one (isNew=false) or a fresh draft.
  const [editing, setEditing] = useState<{ workflow: Workflow; isNew: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workflows.filter((w) => workflowMatches(w, q));
  }, [workflows, query]);

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
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Failed to duplicate "${original.name}"`, { description: message });
      }
    },
    [workflows, saveWorkflowToBackend]
  );

  // Write serialized workflows to a user-chosen file. A cancelled save dialog
  // returns null before any write (silent no-op); only a real write failure
  // surfaces an error toast.
  const writeWorkflowsToFile = useCallback(
    async (payload: Workflow[], defaultPath: string, successMessage: string) => {
      try {
        const filePath = await save({
          defaultPath,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!filePath) return;
        await writeTextFile(filePath, serializeWorkflows(payload));
        toast.success(successMessage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Failed to export workflows: ${message}`);
      }
    },
    []
  );

  const handleExportAll = useCallback(() => {
    void writeWorkflowsToFile(
      workflows,
      "termihub-workflows.json",
      `Exported ${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`
    );
  }, [workflows, writeWorkflowsToFile]);

  const handleExportOne = useCallback(
    (workflowId: string) => {
      const workflow = workflows.find((w) => w.id === workflowId);
      if (!workflow) return;
      void writeWorkflowsToFile(
        [workflow],
        `termihub-workflow-${slugifyWorkflowName(workflow.name)}.json`,
        `Exported "${workflow.name}"`
      );
    },
    [workflows, writeWorkflowsToFile]
  );

  const handleImport = useCallback(async () => {
    const filePath = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!filePath || Array.isArray(filePath)) return;
    try {
      const json = await readTextFile(filePath);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to import workflows: ${message}`);
    }
  }, [importWorkflows]);

  const handleDelete = useCallback(
    (workflowId: string) => {
      const workflow = workflows.find((w) => w.id === workflowId);
      if (!workflow) return;
      setPendingDelete({ id: workflow.id, name: workflow.name });
    },
    [workflows]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { id, name } = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteWorkflowFromBackend(id);
      toast.success(`Deleted workflow "${name}"`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to delete workflow: ${message}`);
    }
  }, [pendingDelete, deleteWorkflowFromBackend]);

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
      };
      try {
        await saveWorkflowToBackend(updated);
        setEditing(null);
        toast.success(`Saved workflow "${result.name}"`);
      } catch (err) {
        // Keep the dialog open so the edits are not lost on a failed save.
        const message = err instanceof Error ? err.message : String(err);
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
      <div className="workflow-sidebar__actions">
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
        <Tooltip content="Export All Workflows" side="top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Download size={14} />}
            onClick={handleExportAll}
            disabled={workflows.length === 0}
            aria-label="Export All Workflows"
            data-testid="workflow-export-all-btn"
          />
        </Tooltip>
        <Tooltip content="Import Workflows" side="top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Upload size={14} />}
            onClick={handleImport}
            aria-label="Import Workflows"
            data-testid="workflow-import-btn"
          />
        </Tooltip>
      </div>
      <div className="workflow-sidebar__search">
        <Search size={14} className="workflow-sidebar__search-icon" aria-hidden="true" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workflows"
          aria-label="Search workflows"
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
                running={workflowRun?.workflowId === workflow.id}
                onRun={handleRun}
                onCancel={cancelWorkflowRun}
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
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        message={
          pendingDelete ? `Delete workflow "${pendingDelete.name}"? This cannot be undone.` : ""
        }
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
