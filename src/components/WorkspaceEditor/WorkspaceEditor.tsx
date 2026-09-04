import { useState, useCallback, useEffect } from "react";
import { Plus, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useLayoutRenderTree } from "@/store/layoutSelectors";
import { WorkspaceEditorMeta } from "@/types/terminal";
import { WorkspaceDefinition, WorkspaceLayoutNode, WorkspaceTabGroupDef } from "@/types/workspace";
import { loadWorkspace } from "@/services/workspaceApi";
import { getWorkspaceLeaves, countWorkspaceTabs } from "@/utils/workspaceLayout";
import { Button, Input, Field, Tooltip } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
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

const DEFAULT_GROUP_NAME = "Main";

export function WorkspaceEditor({ tabId, meta, isVisible }: WorkspaceEditorProps) {
  const saveWorkspace = useAppStore((s) => s.saveWorkspaceToBackend);
  const closeTab = useAppStore((s) => s.closeTab);
  const rootPanel = useLayoutRenderTree();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tabGroupDefs, setTabGroupDefs] = useState<WorkspaceTabGroupDef[]>([
    { name: DEFAULT_GROUP_NAME, layout: DEFAULT_LAYOUT },
  ]);
  const [activeGroupIndex, setActiveGroupIndex] = useState(0);
  const [loading, setLoading] = useState(!!meta.workspaceId);
  const [renamingGroupIndex, setRenamingGroupIndex] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    if (meta.workspaceId) {
      setLoading(true);
      loadWorkspace(meta.workspaceId)
        .then((ws) => {
          setName(ws.name);
          setDescription(ws.description ?? "");
          setTabGroupDefs(
            ws.tabGroups.length > 0
              ? ws.tabGroups
              : [{ name: DEFAULT_GROUP_NAME, layout: DEFAULT_LAYOUT }]
          );
          setActiveGroupIndex(0);
        })
        .catch(() => {
          // Discard broken workspace; editor starts fresh
          setTabGroupDefs([{ name: DEFAULT_GROUP_NAME, layout: DEFAULT_LAYOUT }]);
        })
        .finally(() => setLoading(false));
    }
  }, [meta.workspaceId]);

  const updateActiveGroupLayout = useCallback(
    (layout: WorkspaceLayoutNode) => {
      setTabGroupDefs((prev) =>
        prev.map((g, i) => (i === activeGroupIndex ? { ...g, layout } : g))
      );
    },
    [activeGroupIndex]
  );

  const handleAddGroup = useCallback(() => {
    const newGroup: WorkspaceTabGroupDef = {
      name: `Group ${tabGroupDefs.length + 1}`,
      layout: DEFAULT_LAYOUT,
    };
    setTabGroupDefs((prev) => [...prev, newGroup]);
    setActiveGroupIndex(tabGroupDefs.length);
  }, [tabGroupDefs.length]);

  const handleCloseGroup = useCallback(
    (index: number) => {
      if (tabGroupDefs.length <= 1) return;
      const newDefs = tabGroupDefs.filter((_, i) => i !== index);
      setTabGroupDefs(newDefs);
      setActiveGroupIndex((prev) => {
        if (prev < index) return prev;
        if (prev === index) return Math.max(0, index - 1);
        return prev - 1;
      });
    },
    [tabGroupDefs]
  );

  const startRename = useCallback((index: number, currentName: string) => {
    setRenamingGroupIndex(index);
    setRenameValue(currentName);
  }, []);

  const commitRename = useCallback(
    (index: number) => {
      const trimmed = renameValue.trim();
      if (trimmed) {
        setTabGroupDefs((prev) => prev.map((g, i) => (i === index ? { ...g, name: trimmed } : g)));
      }
      setRenamingGroupIndex(null);
    },
    [renameValue]
  );

  const handleSave = useCallback(async () => {
    const definition: WorkspaceDefinition = {
      id: meta.workspaceId ?? `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name || "Untitled Workspace",
      description: description || undefined,
      tabGroups: tabGroupDefs,
    };

    try {
      await saveWorkspace(definition);
      const { findLeafByTab } = await import("@/utils/panelTree");
      const leaf = findLeafByTab(rootPanel, tabId);
      if (leaf) {
        closeTab(tabId, leaf.id);
      }
    } catch (err) {
      // Save failed — surface it via the async Button's error toast and stay open.
      frontendLog("workspace_editor", `Failed to save workspace: ${err}`);
      throw err instanceof Error ? err : new Error("Failed to save workspace");
    }
  }, [
    meta.workspaceId,
    name,
    description,
    tabGroupDefs,
    saveWorkspace,
    closeTab,
    rootPanel,
    tabId,
  ]);

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

  const activeGroup = tabGroupDefs[activeGroupIndex] ?? tabGroupDefs[0];
  const showGroupStrip = tabGroupDefs.length > 1;

  const totalLeaves = tabGroupDefs.reduce((sum, g) => sum + getWorkspaceLeaves(g.layout).length, 0);
  const totalTabs = tabGroupDefs.reduce((sum, g) => sum + countWorkspaceTabs(g.layout), 0);

  const infoLine = showGroupStrip
    ? `${tabGroupDefs.length} groups · ${totalLeaves} ${totalLeaves === 1 ? "panel" : "panels"} · ${totalTabs} ${totalTabs === 1 ? "tab" : "tabs"}`
    : `${totalLeaves} ${totalLeaves === 1 ? "panel" : "panels"}, ${totalTabs} ${totalTabs === 1 ? "tab" : "tabs"}`;

  return (
    <div className="workspace-editor" data-testid="workspace-editor">
      <div className="workspace-editor__header">
        <h2 className="workspace-editor__title">
          {meta.workspaceId ? "Edit Workspace" : "New Workspace"}
        </h2>
      </div>

      <div className="workspace-editor__form">
        <Field label="Name" htmlFor="ws-name" className="workspace-editor__field">
          <Input
            id="ws-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            data-testid="workspace-name-input"
          />
        </Field>

        <Field label="Description" htmlFor="ws-description" className="workspace-editor__field">
          <Input
            id="ws-description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            data-testid="workspace-description-input"
          />
        </Field>

        <div className="workspace-editor__layout-section">
          <div className="workspace-editor__layout-header">
            <label className="workspace-editor__label">Layout</label>
            <span className="workspace-editor__layout-info">{infoLine}</span>
          </div>

          {showGroupStrip && (
            <div className="workspace-group-strip" data-testid="workspace-group-strip">
              {tabGroupDefs.map((group, index) => (
                <div
                  key={index}
                  className={`workspace-group-chip${index === activeGroupIndex ? " workspace-group-chip--active" : ""}`}
                  onClick={() => setActiveGroupIndex(index)}
                  data-testid={`workspace-group-chip-${index}`}
                >
                  {renamingGroupIndex === index ? (
                    <Input
                      inline
                      autoFocus
                      className="workspace-group-chip__rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(index)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(index);
                        if (e.key === "Escape") setRenamingGroupIndex(null);
                        e.stopPropagation();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      data-testid={`workspace-group-rename-input-${index}`}
                    />
                  ) : (
                    <span
                      className="workspace-group-chip__name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setActiveGroupIndex(index);
                        startRename(index, group.name);
                      }}
                    >
                      {group.name}
                    </span>
                  )}
                  <Tooltip content="Remove group" side="top">
                    <button
                      className="workspace-group-chip__close"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseGroup(index);
                      }}
                      aria-label="Remove group"
                      data-testid={`workspace-group-close-${index}`}
                    >
                      <X size={10} />
                    </button>
                  </Tooltip>
                </div>
              ))}
              <Tooltip content="Add group" side="top">
                <button
                  className="workspace-group-strip__add"
                  onClick={handleAddGroup}
                  aria-label="Add group"
                  data-testid="workspace-group-add"
                >
                  <Plus size={12} />
                </button>
              </Tooltip>
            </div>
          )}

          {!showGroupStrip && (
            <div className="workspace-group-strip workspace-group-strip--single">
              <Tooltip content="Add group" side="top">
                <button
                  className="workspace-group-strip__add"
                  onClick={handleAddGroup}
                  aria-label="Add group"
                  data-testid="workspace-group-add"
                >
                  <Plus size={12} />
                  Add Group
                </button>
              </Tooltip>
            </div>
          )}

          <LayoutDesigner layout={activeGroup.layout} onChange={updateActiveGroupLayout} />
        </div>
      </div>

      <div className="workspace-editor__actions">
        <Button variant="primary" onClick={handleSave} data-testid="workspace-save-btn">
          Save
        </Button>
        <Button variant="secondary" onClick={handleCancel} data-testid="workspace-cancel-btn">
          Cancel
        </Button>
      </div>
    </div>
  );
}
