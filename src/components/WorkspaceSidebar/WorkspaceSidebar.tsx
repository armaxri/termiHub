import { useCallback, useState } from "react";
import { Plus, Save, Download, Upload } from "lucide-react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import { exportWorkspaces, importWorkspaces } from "@/services/workspaceApi";
import { WorkspaceListItem } from "./WorkspaceListItem";
import { SaveWorkspaceDialog, SaveWorkspaceScope } from "./SaveWorkspaceDialog";
import "./WorkspaceSidebar.css";

export function WorkspaceSidebar() {
  const workspaces = useAppStore((s) => s.workspaces);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspaceFromBackend);
  const duplicateWorkspace = useAppStore((s) => s.duplicateWorkspaceInBackend);
  const openWorkspaceEditorTab = useAppStore((s) => s.openWorkspaceEditorTab);
  const launchWorkspace = useAppStore((s) => s.launchWorkspace);
  const saveCurrentAsWorkspace = useAppStore((s) => s.saveCurrentAsWorkspace);
  const tabGroups = useAppStore((s) => s.tabGroups);
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId);

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
    (name: string, scope: SaveWorkspaceScope, description?: string) => {
      saveCurrentAsWorkspace(name, scope, description);
      setShowSaveDialog(false);
    },
    [saveCurrentAsWorkspace]
  );

  const loadWorkspaces = useAppStore((s) => s.loadWorkspaces);

  const handleExport = useCallback(async () => {
    try {
      const json = await exportWorkspaces();
      const filePath = await save({
        defaultPath: "termihub-workspaces.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, json);
    } catch {
      // Export cancelled or failed
    }
  }, []);

  const handleImport = useCallback(async () => {
    try {
      const filePath = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      const json = await readTextFile(filePath);
      await importWorkspaces(json);
      await loadWorkspaces();
    } catch {
      // Import cancelled or failed
    }
  }, [loadWorkspaces]);

  const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId);
  const activeGroupName = activeGroup?.name ?? "Main";

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
        <button
          className="workspace-sidebar__add-btn"
          onClick={handleExport}
          title="Export Workspaces"
          data-testid="workspace-export-btn"
        >
          <Download size={14} />
        </button>
        <button
          className="workspace-sidebar__add-btn"
          onClick={handleImport}
          title="Import Workspaces"
          data-testid="workspace-import-btn"
        >
          <Upload size={14} />
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
        <SaveWorkspaceDialog
          tabGroupCount={tabGroups.length}
          activeGroupName={activeGroupName}
          onSave={handleSaveCurrent}
          onCancel={() => setShowSaveDialog(false)}
        />
      )}
    </div>
  );
}
