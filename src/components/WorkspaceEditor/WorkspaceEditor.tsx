import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Pencil, Plus, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useLayoutRenderTree } from "@/store/layoutSelectors";
import { WorkspaceEditorMeta } from "@/types/terminal";
import {
  WorkspaceDefinition,
  WorkspaceLayoutNode,
  WorkspaceSettings,
  WorkspaceTabGroupDef,
  WorkspaceWindowDef,
} from "@/types/workspace";
import { loadWorkspace } from "@/services/workspaceApi";
import { getWorkspaceLeaves, countWorkspaceTabs } from "@/utils/workspaceLayout";
import { Button, Input, Field, Tooltip, UnsavedChangesDialog } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import { LayoutDesigner } from "./LayoutDesigner";
import { WorkspaceSettingsSection } from "./WorkspaceSettingsSection";
import { ImportedItemsSection } from "./ImportedItemsSection";
import { normalizeWorkspaceSettings } from "@/services/workspaceSettings";
import { newId } from "@/services/transport/ids";
import { useConnectionIdChanges } from "@/hooks/useFollowConnectionIdChanges";
import { remapWorkspaceTabGroups } from "@/utils/connectionIdChanges";
import "./WorkspaceEditor.css";
import { isImeComposing } from "@/utils/imeComposition";
import { errorMessage } from "@/utils/errorMessage";
import { draftKey } from "@/utils/draftKey";
import { findLeafByTab } from "@/utils/panelTree";
import { rovingTabIndexFromKey, focusRovingTab } from "@/utils/rovingTablist";

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

/** The editable part of a workspace draft, compared to its baseline for dirtiness. */
function workspaceDraftKey(
  name: string,
  description: string,
  tabGroupDefs: WorkspaceTabGroupDef[],
  settings: WorkspaceSettings
): string {
  return draftKey({ name, description, tabGroupDefs, settings });
}

export function WorkspaceEditor({ tabId, meta, isVisible }: WorkspaceEditorProps) {
  const saveWorkspace = useAppStore((s) => s.saveWorkspaceToBackend);
  const closeTab = useAppStore((s) => s.closeTab);
  const setEditorDirty = useAppStore((s) => s.setEditorDirty);
  const pendingCloseRequest = useAppStore((s) => s.pendingCloseRequest);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);
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
  const [settings, setSettings] = useState<WorkspaceSettings>({});
  // Carried through unchanged so editing a multi-window workspace keeps its windows.
  const [windows, setWindows] = useState<WorkspaceWindowDef[] | undefined>(undefined);
  // The tab groups the editor was opened with (a new workspace's defaults, or
  // the loaded ones), kept as data rather than a key so a connection rename can
  // be followed in the baseline too (#4413).
  const [baselineGroups, setBaselineGroups] = useState<WorkspaceTabGroupDef[]>(() => [
    { name: DEFAULT_GROUP_NAME, layout: DEFAULT_LAYOUT },
  ]);
  // A saved connection renamed while the editor is open: re-point the draft's
  // tab refs, or saving would write the old id back over the backend's follow (#3603).
  // The remap is not a user edit, so the baseline follows it as well: an
  // unedited editor stays clean, and undoing an edit is clean again (#4413).
  useConnectionIdChanges((remap) => {
    setTabGroupDefs((prev) => remapWorkspaceTabGroups(prev, remap));
    setBaselineGroups((prev) => remapWorkspaceTabGroups(prev, remap));
  });
  // The rest of the values the editor was opened with: the draft differing from
  // the baseline marks the tab dirty (UX2-004).
  const [baselineFields, setBaselineFields] = useState<{
    name: string;
    description: string;
    settings: WorkspaceSettings;
  }>({ name: "", description: "", settings: {} });
  const baselineKey = useMemo(
    () =>
      workspaceDraftKey(
        baselineFields.name,
        baselineFields.description,
        baselineGroups,
        baselineFields.settings
      ),
    [baselineFields, baselineGroups]
  );

  useEffect(() => {
    if (meta.workspaceId) {
      setLoading(true);
      loadWorkspace(meta.workspaceId)
        .then((ws) => {
          const groups =
            ws.tabGroups.length > 0
              ? ws.tabGroups
              : [{ name: DEFAULT_GROUP_NAME, layout: DEFAULT_LAYOUT }];
          setName(ws.name);
          setDescription(ws.description ?? "");
          setSettings(ws.settings ?? {});
          setWindows(ws.windows);
          setTabGroupDefs(groups);
          setActiveGroupIndex(0);
          setBaselineGroups(groups);
          setBaselineFields({
            name: ws.name,
            description: ws.description ?? "",
            settings: ws.settings ?? {},
          });
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

  // Group tab buttons, so focus can return to a tab after its inline rename
  // input unmounts (the input replaces the tab while editing) or after a
  // keyboard Delete removes the focused tab (#4349).
  const groupTabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const refocusGroupIndexRef = useRef<number | null>(null);
  const endRename = useCallback((index: number) => {
    refocusGroupIndexRef.current = index;
    setRenamingGroupIndex(null);
  }, []);
  const groupCount = tabGroupDefs.length;
  useEffect(() => {
    if (renamingGroupIndex !== null || refocusGroupIndexRef.current === null) return;
    groupTabRefs.current[refocusGroupIndexRef.current]?.focus();
    refocusGroupIndexRef.current = null;
  }, [renamingGroupIndex, groupCount]);

  const commitRename = useCallback(
    (index: number) => {
      const trimmed = renameValue.trim();
      if (trimmed) {
        setTabGroupDefs((prev) => prev.map((g, i) => (i === index ? { ...g, name: trimmed } : g)));
      }
      endRename(index);
    },
    [renameValue, endRename]
  );

  const handleSave = useCallback(async () => {
    // Throws a user-facing message on an invalid override; the async Button toasts it.
    const normalizedSettings = normalizeWorkspaceSettings(settings);
    const definition: WorkspaceDefinition = {
      id: meta.workspaceId ?? newId("ws"),
      name: name || "Untitled Workspace",
      description: description || undefined,
      tabGroups: tabGroupDefs,
      ...(windows ? { windows } : {}),
      ...(normalizedSettings ? { settings: normalizedSettings } : {}),
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
      frontendLog("workspace_editor", `Failed to save workspace: ${errorMessage(err)}`);
      throw err instanceof Error ? err : new Error("Failed to save workspace");
    }
  }, [
    meta.workspaceId,
    name,
    description,
    tabGroupDefs,
    settings,
    windows,
    saveWorkspace,
    closeTab,
    rootPanel,
    tabId,
  ]);

  // Report unsaved edits like ConnectionEditor does, so the tab-bar close guard
  // and every bulk close (panel, group, window) see this tab as dirty (UX2-004).
  const isDirty =
    !loading && workspaceDraftKey(name, description, tabGroupDefs, settings) !== baselineKey;
  useEffect(() => {
    setEditorDirty(tabId, isDirty);
  }, [tabId, isDirty, setEditorDirty]);

  const closeThisTab = useCallback(() => {
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf) closeTab(tabId, leaf.id);
  }, [rootPanel, tabId, closeTab]);

  // Cancel shares the tab-bar close guard (UX2-004): with unsaved edits it
  // raises the unsaved-changes prompt via pendingCloseRequest; otherwise the
  // tab closes at once.
  const handleCancel = useCallback(() => {
    if (useAppStore.getState().editorDirtyTabs[tabId]) {
      const leaf = findLeafByTab(rootPanel, tabId);
      if (leaf) setPendingCloseRequest({ tabId, panelId: leaf.id });
      return;
    }
    closeThisTab();
  }, [rootPanel, tabId, setPendingCloseRequest, closeThisTab]);

  // Rendered on every branch, including while hidden: a tab-bar close request
  // can target this tab when it is not the visible one.
  const unsavedDialog = (
    <UnsavedChangesDialog
      open={pendingCloseRequest?.tabId === tabId}
      subject="workspace"
      name={name.trim() || undefined}
      onCancel={() => setPendingCloseRequest(null)}
      onJustClose={() => {
        setPendingCloseRequest(null);
        closeThisTab();
      }}
      onSaveAndClose={async () => {
        // Save closes the tab on success; on failure it throws, the Button
        // toasts the error and the prompt stays up.
        await handleSave();
        setPendingCloseRequest(null);
      }}
    />
  );

  if (!isVisible) return unsavedDialog;

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
              {/* A roving tablist of group tabs (the TabBar pattern, #4349): only
                  the active group is a Tab stop, Arrow/Home/End move focus,
                  Enter/Space/click activate, F2 (or Enter on the active tab)
                  renames and Delete removes. */}
              <div
                className="workspace-group-strip__tabs"
                role="tablist"
                aria-label="Tab groups"
                aria-orientation="horizontal"
                onKeyDown={(e) => {
                  const current = rovingTabIndexFromKey(e);
                  if (current !== -1) focusRovingTab(e, current);
                }}
              >
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
                          if (isImeComposing(e)) return;
                          if (e.key === "Enter") commitRename(index);
                          if (e.key === "Escape") endRename(index);
                          e.stopPropagation();
                        }}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Rename group ${group.name}`}
                        data-testid={`workspace-group-rename-input-${index}`}
                      />
                    ) : (
                      <button
                        type="button"
                        ref={(el) => {
                          groupTabRefs.current[index] = el;
                        }}
                        className="workspace-group-chip__name"
                        role="tab"
                        aria-selected={index === activeGroupIndex}
                        aria-keyshortcuts="F2 Delete"
                        tabIndex={index === activeGroupIndex ? 0 : -1}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveGroupIndex(index);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setActiveGroupIndex(index);
                          startRename(index, group.name);
                        }}
                        onKeyDown={(e) => {
                          // Enter on an inactive tab falls through to the
                          // native click (activate); on the active tab it renames.
                          const renameKey =
                            e.key === "F2" || (e.key === "Enter" && index === activeGroupIndex);
                          if (renameKey) {
                            e.preventDefault();
                            setActiveGroupIndex(index);
                            startRename(index, group.name);
                          } else if (e.key === "Delete" && tabGroupDefs.length > 1) {
                            e.preventDefault();
                            // Keep focus in the tablist on the neighbouring tab.
                            refocusGroupIndexRef.current = Math.max(0, index - 1);
                            handleCloseGroup(index);
                          }
                        }}
                        data-testid={`workspace-group-tab-${index}`}
                      >
                        {group.name}
                      </button>
                    )}
                    {/* Mouse affordance only: keyboard users remove a group with
                        Delete on its tab, and a button inside the tablist is not
                        an allowed tablist child. */}
                    <Tooltip content="Remove group" side="top">
                      <button
                        type="button"
                        className="workspace-group-chip__close"
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCloseGroup(index);
                        }}
                        data-testid={`workspace-group-close-${index}`}
                      >
                        <X size={10} />
                      </button>
                    </Tooltip>
                  </div>
                ))}
              </div>
              <Tooltip content="Rename group" side="top">
                <button
                  type="button"
                  className="workspace-group-strip__add"
                  onClick={() => startRename(activeGroupIndex, activeGroup.name)}
                  aria-label="Rename group"
                  aria-keyshortcuts="F2"
                  data-testid="workspace-group-rename"
                >
                  <Pencil size={12} />
                </button>
              </Tooltip>
              <Tooltip content="Add group" side="top">
                <button
                  type="button"
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

        <ImportedItemsSection tabGroupDefs={tabGroupDefs} />

        <WorkspaceSettingsSection value={settings} onChange={setSettings} />
      </div>

      <div className="workspace-editor__actions">
        <Button variant="primary" onClick={handleSave} data-testid="workspace-save-btn">
          Save
        </Button>
        <Button variant="secondary" onClick={handleCancel} data-testid="workspace-cancel-btn">
          Cancel
        </Button>
      </div>
      {unsavedDialog}
    </div>
  );
}
