import { useCallback, useState } from "react";
import { Plus, Save } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import {
  getAllTabsAcrossGroupTrees,
  useActiveTabGroupId,
  useLayoutTabGroups,
} from "@/store/layoutSelectors";
import { Button, toast, Tooltip, ConfirmDialog } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import { exportWorkspaces, importWorkspaces } from "@/services/workspaceApi";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { useJsonFileExport, useJsonFileImport } from "@/hooks/useJsonFile";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { ExportImportButtons } from "@/components/Sidebar/ExportImportButtons";
import type { WorkspaceSummary } from "@/types/workspace";
import { WorkspaceListItem } from "./WorkspaceListItem";
import { SaveWorkspaceDialog, SaveWorkspaceScope } from "./SaveWorkspaceDialog";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import "./WorkspaceSidebar.css";
import { errorMessage } from "@/utils/errorMessage";

export function WorkspaceSidebar() {
  const workspaces = useAppStore((s) => s.workspaces);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspaceFromBackend);
  const duplicateWorkspace = useAppStore((s) => s.duplicateWorkspaceInBackend);
  const openWorkspaceEditorTab = useAppStore((s) => s.openWorkspaceEditorTab);
  const launchWorkspace = useAppStore((s) => s.launchWorkspace);
  const launchingWorkspaceId = useAppStore((s) => s.launchingWorkspaceId);
  const saveCurrentAsWorkspace = useAppStore((s) => s.saveCurrentAsWorkspace);
  const tabGroups = useLayoutTabGroups();
  const activeTabGroupId = useActiveTabGroupId();

  const [showSaveDialog, setShowSaveDialog] = useState(false);
  // The save that is waiting on an overwrite confirmation because its name
  // collides with an existing workspace (UX-027). `id` is the existing
  // workspace's id, reused so overwriting is a true in-place update.
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    id: string;
    name: string;
    scope: SaveWorkspaceScope;
    description?: string;
  } | null>(null);
  // The workspace pending launch once the user confirms tearing down live
  // sessions (UX-026). `count` is the number of open sessions that would be lost.
  const [pendingLaunch, setPendingLaunch] = useState<{
    id: string;
    name: string;
    count: number;
  } | null>(null);

  // The delete/export/import flows come from the shared sidebar hooks (UISF-020).
  const exportWorkspacesToFile = useJsonFileExport("workspaces");
  const importWorkspacesFromFile = useJsonFileImport("workspaces");
  const workspaceDelete = useDeleteConfirm<{ id: string; name: string }>(async ({ id, name }) => {
    try {
      // The store only removes the item from local state after the backend
      // resolves, so a failed delete leaves the workspace visible.
      await deleteWorkspace(id);
      toast.success(`Deleted workspace ${name}`);
    } catch (err) {
      const message = errorMessage(err);
      toast.error(`Failed to delete workspace: ${message}`);
    }
  });
  const requestDelete = workspaceDelete.request;

  const handleNew = useCallback(() => {
    openWorkspaceEditorTab(null);
  }, [openWorkspaceEditorTab]);

  // Launching a workspace tears down every live session before swapping in the
  // new layout (`teardownAllSessions`, appStore.ts). Delete is guarded but the
  // more-destructive Launch was not (UX-026), so confirm first — but ONLY when
  // there are live sessions to lose. When nothing is running, launch directly so
  // the common case is not nagged.
  const handleLaunch = useCallback(
    (workspaceId: string) => {
      const liveCount = getAllTabsAcrossGroupTrees().filter((t) => t.sessionId).length;
      if (liveCount > 0) {
        const workspace = workspaces.find((ws) => ws.id === workspaceId);
        setPendingLaunch({
          id: workspaceId,
          name: workspace?.name ?? "this workspace",
          count: liveCount,
        });
        return;
      }
      launchWorkspace(workspaceId);
    },
    [launchWorkspace, workspaces]
  );

  const handleConfirmLaunch = useCallback(() => {
    if (!pendingLaunch) return;
    const { id } = pendingLaunch;
    setPendingLaunch(null);
    void launchWorkspace(id);
  }, [pendingLaunch, launchWorkspace]);

  const handleEdit = useCallback(
    (workspaceId: string) => {
      openWorkspaceEditorTab(workspaceId);
    },
    [openWorkspaceEditorTab]
  );

  const handleDuplicate = useCallback(
    (workspaceId: string) => {
      duplicateWorkspace(workspaceId);
    },
    [duplicateWorkspace]
  );

  // Open the confirmation dialog rather than deleting immediately — delete is a
  // destructive one-click action on a named workspace (GAP G7).
  const handleDelete = useCallback(
    (workspaceId: string) => {
      const workspace = workspaces.find((ws) => ws.id === workspaceId);
      if (!workspace) return;
      requestDelete({ id: workspace.id, name: workspace.name });
    },
    [workspaces, requestDelete]
  );

  // Persist the current layout as a workspace. `overwriteId` reuses an existing
  // workspace's id so the save is a true update rather than a duplicate (UX-027).
  const persistWorkspace = useCallback(
    async (name: string, scope: SaveWorkspaceScope, description?: string, overwriteId?: string) => {
      try {
        await saveCurrentAsWorkspace(name, scope, description, overwriteId);
        setPendingOverwrite(null);
        setShowSaveDialog(false);
        toast.success(overwriteId ? `Updated workspace ${name}` : `Saved workspace ${name}`);
      } catch (err) {
        // Keep the dialog open so the user does not falsely believe the save
        // succeeded (disk full / permission / lock poisoned would otherwise
        // vanish silently — GAP G2).
        const message = errorMessage(err);
        frontendLog("workspace", `Failed to save workspace "${name}": ${message}`);
        toast.error(`Failed to save workspace: ${message}`);
      }
    },
    [saveCurrentAsWorkspace]
  );

  const handleSaveCurrent = useCallback(
    async (name: string, scope: SaveWorkspaceScope, description?: string) => {
      // Saving over an existing name used to silently create a second,
      // indistinguishable workspace (UX-027). Detect the collision (trimmed,
      // case-insensitive — matching the connection editor's unique-name check)
      // and defer to an overwrite confirmation instead of writing straight away.
      const target = name.trim().toLowerCase();
      const existing = workspaces.find((ws) => ws.name.trim().toLowerCase() === target);
      if (existing) {
        setPendingOverwrite({ id: existing.id, name, scope, description });
        return;
      }
      await persistWorkspace(name, scope, description);
    },
    [workspaces, persistWorkspace]
  );

  const handleConfirmOverwrite = useCallback((): Promise<void> | undefined => {
    if (!pendingOverwrite) return undefined;
    const { id, name, scope, description } = pendingOverwrite;
    return persistWorkspace(name, scope, description, id);
  }, [pendingOverwrite, persistWorkspace]);

  const loadWorkspaces = useAppStore((s) => s.loadWorkspaces);

  // A cancelled file dialog is a silent no-op (no toast). Only a genuine failure
  // surfaces an error (GAP G8).
  const handleExport = useCallback(() => {
    void exportWorkspacesToFile({
      defaultPath: "termihub-workspaces.json",
      content: () => exportWorkspaces(),
      successMessage: "Exported workspaces",
    });
  }, [exportWorkspacesToFile]);

  // A cancelled file dialog is a silent no-op. A parse failure or duplicate-skip
  // must be reported so the user can tell if 0, some, or all workspaces imported
  // (GAP G8).
  const handleImport = useCallback(() => {
    void importWorkspacesFromFile(async (json) => {
      const count = await importWorkspaces(json);
      await loadWorkspaces();
      toast.success(`Imported ${count} workspace${count === 1 ? "" : "s"}`);
    });
  }, [loadWorkspaces, importWorkspacesFromFile]);

  const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId);
  const activeGroupName = activeGroup?.name ?? "Main";

  // Roving-tabindex keyboard navigation over the flat workspace list, matching
  // the Connections tree's arrow-key + Enter model. Enter launches the focused
  // workspace (the same action as double-click), unless a launch is in flight.
  const handleActivate = useCallback(
    (workspace: WorkspaceSummary) => {
      if (launchingWorkspaceId === null) handleLaunch(workspace.id);
    },
    [launchingWorkspaceId, handleLaunch]
  );
  const nav = useFlatRovingNav<WorkspaceSummary, HTMLDivElement>(
    workspaces,
    (workspace) => workspace.name,
    handleActivate
  );

  return (
    <div className="workspace-sidebar" data-testid="workspace-sidebar">
      <SidebarToolbar>
        <Tooltip content="New Workspace" side="top">
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus size={14} />}
            onClick={handleNew}
            aria-label="New Workspace"
            data-testid="workspace-new-btn"
          >
            New Workspace
          </Button>
        </Tooltip>
        <Tooltip content="Save Current Layout" side="top">
          <Button
            variant="ghost"
            size="sm"
            icon={<Save size={14} />}
            onClick={() => setShowSaveDialog(true)}
            aria-label="Save Current Layout"
            data-testid="workspace-save-current-btn"
          >
            Save Current
          </Button>
        </Tooltip>
        <ExportImportButtons
          onExport={handleExport}
          onImport={handleImport}
          exportLabel="Export Workspaces"
          importLabel="Import Workspaces"
          exportTestId="workspace-export-btn"
          importTestId="workspace-import-btn"
        />
      </SidebarToolbar>
      {workspaces.length === 0 ? (
        <div className="workspace-sidebar__empty" data-testid="workspace-empty-message">
          <span>No workspaces configured.</span>
          <span>Click &quot;+ New Workspace&quot; to create one.</span>
        </div>
      ) : (
        <div
          className="workspace-sidebar__list"
          data-testid="workspace-list"
          role="tree"
          aria-label="Workspaces"
          onKeyDown={nav.onKeyDown}
        >
          {workspaces.map((workspace, index) => {
            const { ref, ...itemProps } = nav.getItemProps(index);
            return (
              <WorkspaceListItem
                key={workspace.id}
                workspace={workspace}
                onLaunch={handleLaunch}
                onEdit={handleEdit}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                launchDisabled={launchingWorkspaceId !== null}
                rowRef={ref}
                rowProps={itemProps}
              />
            );
          })}
        </div>
      )}
      {showSaveDialog && (
        <SaveWorkspaceDialog
          tabGroupCount={tabGroups.length}
          activeGroupName={activeGroupName}
          onSave={handleSaveCurrent}
          onCancel={() => setShowSaveDialog(false)}
        />
      )}
      <ConfirmDialog
        open={pendingOverwrite !== null}
        variant="danger"
        title="Overwrite workspace?"
        description="Replace the existing workspace's saved layout with the current one."
        message={
          pendingOverwrite
            ? `A workspace named "${pendingOverwrite.name}" already exists. Overwrite it with ` +
              `the current layout, or cancel to save under a different name.`
            : ""
        }
        confirmLabel="Overwrite"
        confirmVariant="danger"
        confirmErrorToast={false}
        testIdBase="confirm-overwrite-workspace"
        data-testid="confirm-overwrite-workspace-dialog"
        onConfirm={handleConfirmOverwrite}
        onCancel={() => setPendingOverwrite(null)}
      />
      <ConfirmDeleteDialog
        {...workspaceDelete.dialogProps}
        message={
          workspaceDelete.pending
            ? `Delete workspace "${workspaceDelete.pending.name}"? This cannot be undone.`
            : ""
        }
      />
      <ConfirmDialog
        open={pendingLaunch !== null}
        variant="danger"
        title="Close live sessions?"
        message={
          pendingLaunch
            ? `Launching "${pendingLaunch.name}" will close ${pendingLaunch.count} open ` +
              `session${pendingLaunch.count === 1 ? "" : "s"} and replace your current layout. ` +
              `Continue?`
            : ""
        }
        confirmLabel="Launch"
        confirmVariant="danger"
        testIdBase="confirm-launch-workspace"
        data-testid="confirm-launch-workspace-dialog"
        onConfirm={handleConfirmLaunch}
        onCancel={() => setPendingLaunch(null)}
      />
    </div>
  );
}
