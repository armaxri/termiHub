import { useMemo } from "react";
import { getActiveTab, useAppStore } from "@/store/appStore";
import type { FileBrowserMode } from "@/store/fileBrowsersBridge";
import { getAllTabsAcrossGroupTrees } from "@/store/layoutSelectors";
import type { TerminalTab } from "@/types/terminal";
import { fileBookmarkScope } from "@/utils/fileBookmarkScope";

/**
 * The tab that owns the file browser's filesystem. In session mode it is the
 * terminal tab that owns the browsed session — the active tab itself, or (for a
 * remote editor tab) the terminal tab behind it; otherwise the active tab.
 */
export function useFileBrowserOwnerTab(
  mode: FileBrowserMode,
  sessionId: string | null
): TerminalTab | null {
  const activeTab = useAppStore((s) => getActiveTab(s));
  return useMemo(() => {
    if (mode !== "session") return activeTab;
    if (!sessionId) return null;
    if (activeTab?.sessionId === sessionId) return activeTab;
    return (
      getAllTabsAcrossGroupTrees().find((t) => t.sessionId === sessionId && !t.editorMeta) ?? null
    );
  }, [mode, sessionId, activeTab]);
}

/**
 * The bookmark scope of the file browser (PROD-007, #3558), derived from the
 * tab that owns the browsed filesystem ({@link useFileBrowserOwnerTab}).
 */
export function useFileBookmarkScope(
  mode: FileBrowserMode,
  sessionId: string | null
): string | null {
  const owner = useFileBrowserOwnerTab(mode, sessionId);
  return useMemo(() => {
    if (mode === "session" && !sessionId) return null;
    return fileBookmarkScope(mode, owner);
  }, [mode, sessionId, owner]);
}
