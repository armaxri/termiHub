import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { useLayoutRenderTree } from "@/store/layoutSelectors";
import { findLeafByTab } from "@/utils/panelTree";

/**
 * What every service editor does with its tab (#6028): it says when it has unsaved
 * changes, closes itself after a save, and asks first when Cancel or Escape would
 * lose them, with the prompt that closing the tab brings, too.
 */
export function useEditorTab(tabId: string, isDirty: boolean) {
  const closeTab = useAppStore((s) => s.closeTab);
  const setEditorDirty = useAppStore((s) => s.setEditorDirty);
  const pendingCloseRequest = useAppStore((s) => s.pendingCloseRequest);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);
  const rootPanel = useLayoutRenderTree();

  useEffect(() => {
    setEditorDirty(tabId, isDirty);
  }, [tabId, isDirty, setEditorDirty]);

  const close = () => {
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf) closeTab(tabId, leaf.id);
  };

  return {
    close,
    /** Close it, after asking about unsaved changes. */
    cancel: () => {
      const leaf = findLeafByTab(rootPanel, tabId);
      if (!leaf) return;
      if (useAppStore.getState().editorDirtyTabs[tabId]) {
        setPendingCloseRequest({ tabId, panelId: leaf.id });
      } else {
        closeTab(tabId, leaf.id);
      }
    },
    /** Whether the prompt about unsaved changes is open. */
    asking: pendingCloseRequest?.tabId === tabId,
    stopAsking: () => setPendingCloseRequest(null),
  };
}
