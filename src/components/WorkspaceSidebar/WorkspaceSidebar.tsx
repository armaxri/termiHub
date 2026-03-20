import { useCallback, useState } from "react";
import { Plus, Save } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { WorkspaceListItem } from "./WorkspaceListItem";
import { SaveWorkspaceDialog } from "./SaveWorkspaceDialog";
import "./WorkspaceSidebar.css";

export function WorkspaceSidebar() {
  const workspaces = useAppStore((s) => s.workspaces);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspaceFromBackend);
  const duplicateWorkspace = useAppStore((s) => s.duplicateWorkspaceInBackend);
  const openWorkspaceEditorTab = useAppStore((s) => s.openWorkspaceEditorTab);
  const launchWorkspace = useAppStore((s) => s.launchWorkspace);
  const saveCurrentAsWorkspace = useAppStore((s) => s.saveCurrentAsWorkspace);

  const [showSaveDialog, setShowSaveDialog] = useState(false);

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

  const handleDelete = useCallback(
    (workspaceId: string) => {
      deleteWorkspace(workspaceId);
    },
    [deleteWorkspace]
  );

  const handleSaveCurrent = useCallback(
    (name: string, description?: string) => {
      saveCurrentAsWorkspace(name, description);
      setShowSaveDialog(false);
    },
    [saveCurrentAsWorkspace]
  );

  return (
    <div className="workspace-sidebar" data-testid="workspace-sidebar">
      <div className="workspace-sidebar__actions">
        <button
          className="workspace-sidebar__add-btn"
          onClick={handleNew}
          title="New Workspace"
          data-testid="workspace-new-btn"
        >
          <Plus size={14} />
          New Workspace
        </button>
        <button
          className="workspace-sidebar__add-btn"
          onClick={() => setShowSaveDialog(true)}
          title="Save Current Layout"
          data-testid="workspace-save-current-btn"
        >
          <Save size={14} />
          Save Current
        </button>
      </div>
      {workspaces.length === 0 ? (
        <div className="workspace-sidebar__empty" data-testid="workspace-empty-message">
          <span>No workspaces configured.</span>
          <span>Click &quot;+ New Workspace&quot; to create one.</span>
        </div>
      ) : (
        <div className="workspace-sidebar__list" data-testid="workspace-list">
          {workspaces.map((workspace) => (
            <WorkspaceListItem
              key={workspace.id}
              workspace={workspace}
              onLaunch={handleLaunch}
              onEdit={handleEdit}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
      {showSaveDialog && (
        <SaveWorkspaceDialog onSave={handleSaveCurrent} onCancel={() => setShowSaveDialog(false)} />
      )}
    </div>
  );
}
