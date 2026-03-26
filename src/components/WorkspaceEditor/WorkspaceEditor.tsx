import { useState, useCallback, useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { WorkspaceEditorMeta } from "@/types/terminal";
import { WorkspaceDefinition, WorkspaceLayoutNode } from "@/types/workspace";
import { loadWorkspace } from "@/services/workspaceApi";
import { getWorkspaceLeaves, countWorkspaceTabs } from "@/utils/workspaceLayout";
import { LayoutDesigner } from "./LayoutDesigner";
import "./WorkspaceEditor.css";

interface WorkspaceEditorProps {
  tabId: string;
  meta: WorkspaceEditorMeta;
  isVisible: boolean;
}

const DEFAULT_LAYOUT: WorkspaceLayoutNode = {
  type: "leaf",
  tabs: [],
};

export function WorkspaceEditor({ tabId, meta, isVisible }: WorkspaceEditorProps) {
  const saveWorkspace = useAppStore((s) => s.saveWorkspaceToBackend);
  const closeTab = useAppStore((s) => s.closeTab);
  const rootPanel = useAppStore((s) => s.rootPanel);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [layout, setLayout] = useState<WorkspaceLayoutNode>(DEFAULT_LAYOUT);
  const [loading, setLoading] = useState(!!meta.workspaceId);

  useEffect(() => {
    if (meta.workspaceId) {
      setLoading(true);
      loadWorkspace(meta.workspaceId)
        .then((ws) => {
          setName(ws.name);
          setDescription(ws.description ?? "");
          setLayout(ws.layout ?? DEFAULT_LAYOUT);
        })
        .catch((err) => console.error("Failed to load workspace:", err))
        .finally(() => setLoading(false));
    }
  }, [meta.workspaceId]);

  const handleSave = useCallback(async () => {
    const definition: WorkspaceDefinition = {
      id: meta.workspaceId ?? `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name || "Untitled Workspace",
      description: description || undefined,
      layout,
    };

    try {
      await saveWorkspace(definition as Parameters<typeof saveWorkspace>[0]);
      const { findLeafByTab } = await import("@/utils/panelTree");
      const leaf = findLeafByTab(rootPanel, tabId);
      if (leaf) {
        closeTab(tabId, leaf.id);
      }
    } catch (err) {
      console.error("Failed to save workspace:", err);
    }
  }, [meta.workspaceId, name, description, layout, saveWorkspace, closeTab, rootPanel, tabId]);

  const handleCancel = useCallback(async () => {
    const { findLeafByTab } = await import("@/utils/panelTree");
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf) {
      closeTab(tabId, leaf.id);
    }
  }, [rootPanel, tabId, closeTab]);

  if (!isVisible) return null;

  if (loading) {
    return (
      <div className="workspace-editor" data-testid="workspace-editor">
        <div className="workspace-editor__loading">Loading workspace...</div>
      </div>
    );
  }

  return (
    <div className="workspace-editor" data-testid="workspace-editor">
      <div className="workspace-editor__header">
        <h2 className="workspace-editor__title">
          {meta.workspaceId ? "Edit Workspace" : "New Workspace"}
        </h2>
      </div>

      <div className="workspace-editor__form">
        <div className="workspace-editor__field">
          <label className="workspace-editor__label" htmlFor="ws-name">
            Name
          </label>
          <input
            id="ws-name"
            className="workspace-editor__input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            data-testid="workspace-name-input"
          />
        </div>

        <div className="workspace-editor__field">
          <label className="workspace-editor__label" htmlFor="ws-description">
            Description
          </label>
          <input
            id="ws-description"
            className="workspace-editor__input"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            data-testid="workspace-description-input"
          />
        </div>

        <div className="workspace-editor__layout-section">
          <div className="workspace-editor__layout-header">
            <label className="workspace-editor__label">Layout</label>
            <span className="workspace-editor__layout-info">
              {(() => {
                const leaves = getWorkspaceLeaves(layout);
                const tabs = countWorkspaceTabs(layout);
                return `${leaves.length} ${leaves.length === 1 ? "panel" : "panels"}, ${tabs} ${tabs === 1 ? "tab" : "tabs"}`;
              })()}
            </span>
          </div>
          <LayoutDesigner layout={layout} onChange={setLayout} />
        </div>
      </div>

      <div className="workspace-editor__actions">
        <button
          className="workspace-editor__btn workspace-editor__btn--primary"
          onClick={handleSave}
          data-testid="workspace-save-btn"
        >
          Save
        </button>
        <button
          className="workspace-editor__btn"
          onClick={handleCancel}
          data-testid="workspace-cancel-btn"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
