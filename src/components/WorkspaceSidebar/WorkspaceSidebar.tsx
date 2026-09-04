import { useCallback, useState } from "react";
import { Plus, Save, Download, Upload } from "lucide-react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import { useActiveTabGroupId, useLayoutTabGroups } from "@/store/layoutSelectors";
import { Button, toast, Tooltip } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import { exportWorkspaces, importWorkspaces } from "@/services/workspaceApi";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import type { WorkspaceSummary } from "@/types/workspace";
import { WorkspaceListItem } from "./WorkspaceListItem";
import { SaveWorkspaceDialog, SaveWorkspaceScope } from "./SaveWorkspaceDialog";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import "./WorkspaceSidebar.css";

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
  // The workspace pending deletion once the user confirms the destructive action.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const handleNew = useCallback(() => {
    openWorkspaceEditorTab(null);
  }, [openWorkspaceEditorTab]);

  const handleLaunch = useCallback(
    (workspaceId: string) => {
      launchWorkspace(workspaceId);
    },
    [launchWorkspace]
  );

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
      setPendingDelete({ id: workspace.id, name: workspace.name });
    },
    [workspaces]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { id, name } = pendingDelete;
    setPendingDelete(null);
    try {
      // The store only removes the item from local state after the backend
      // resolves, so a failed delete leaves the workspace visible.
      await deleteWorkspace(id);
      toast.success(`Deleted workspace ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to delete workspace: ${message}`);
    }
  }, [pendingDelete, deleteWorkspace]);

  const handleSaveCurrent = useCallback(
    async (name: string, scope: SaveWorkspaceScope, description?: string) => {
      try {
        await saveCurrentAsWorkspace(name, scope, description);
        setShowSaveDialog(false);
        toast.success(`Saved workspace ${name}`);
      } catch (err) {
        // Keep the dialog open so the user does not falsely believe the save
        // succeeded (disk full / permission / lock poisoned would otherwise
        // vanish silently — GAP G2).
        const message = err instanceof Error ? err.message : String(err);
        frontendLog("workspace", `Failed to save workspace "${name}": ${message}`);
        toast.error(`Failed to save workspace: ${message}`);
      }
    },
    [saveCurrentAsWorkspace]
  );

  const loadWorkspaces = useAppStore((s) => s.loadWorkspaces);

  const handleExport = useCallback(async () => {
    // A cancelled file dialog returns null before any write happens — treat it
    // as a no-op (no toast). Only a genuine failure surfaces an error (GAP G8).
    try {
      const json = await exportWorkspaces();
      const filePath = await save({
        defaultPath: "termihub-workspaces.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, json);
      toast.success("Exported workspaces");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to export workspaces: ${message}`);
    }
  }, []);

  const handleImport = useCallback(async () => {
    // A cancelled file dialog returns null before any work happens — treat it as
    // a no-op (no toast). A parse failure or duplicate-skip must be reported so
    // the user can tell if 0, some, or all workspaces imported (GAP G8).
    const filePath = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!filePath) return;
    try {
      const json = await readTextFile(filePath);
      const count = await importWorkspaces(json);
      await loadWorkspaces();
      toast.success(`Imported ${count} workspace${count === 1 ? "" : "s"}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to import workspaces: ${message}`);
    }
  }, [loadWorkspaces]);

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
      <div className="workspace-sidebar__actions">
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
        <Tooltip content="Export Workspaces" side="top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Download size={14} />}
            onClick={handleExport}
            aria-label="Export Workspaces"
            data-testid="workspace-export-btn"
          />
        </Tooltip>
        <Tooltip content="Import Workspaces" side="top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Upload size={14} />}
            onClick={handleImport}
            aria-label="Import Workspaces"
            data-testid="workspace-import-btn"
          />
        </Tooltip>
      </div>
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
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        message={
          pendingDelete ? `Delete workspace "${pendingDelete.name}"? This cannot be undone.` : ""
        }
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
