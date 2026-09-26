import { useMemo } from "react";
import { getActiveTab, useAppStore } from "@/store/appStore";
import type { FileBrowserMode } from "@/store/fileBrowsersBridge";
import { getAllTabsAcrossGroupTrees } from "@/store/layoutSelectors";
import { fileBookmarkScope } from "@/utils/fileBookmarkScope";

/**
 * The bookmark scope of the file browser (PROD-007, #3558). In session mode the
 * scope comes from the terminal tab that owns the browsed session — the active
 * tab itself, or (for a remote editor tab) the terminal tab behind it.
 */
export function useFileBookmarkScope(
  mode: FileBrowserMode,
  sessionId: string | null
): string | null {
  const activeTab = useAppStore((s) => getActiveTab(s));
  return useMemo(() => {
    if (mode !== "session") return fileBookmarkScope(mode, activeTab);
    if (!sessionId) return null;
    const owner =
      activeTab?.sessionId === sessionId
        ? activeTab
        : getAllTabsAcrossGroupTrees().find((t) => t.sessionId === sessionId && !t.editorMeta);
    return fileBookmarkScope(mode, owner ?? null);
  }, [mode, sessionId, activeTab]);
}
