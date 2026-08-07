import { useLocalFileSystem } from "./useLocalFileSystem";
import { useSessionFileSystem } from "./useSessionFileSystem";
import { useProjectedFileBrowsers } from "@/store/useProjectedFileBrowsers";
import type { FileBrowserPaneView } from "@/store/fileBrowsersBridge";

/**
 * The per-pane UI-state fields a browser renders, sourced from the projected
 * `file-browser@<clientId>` region (#2228 render cut): the pane's listing, cwd,
 * and list-operation loading/error. The active/connected status and the file
 * *actions* still come from the per-mode hook — only these render reads are cut.
 */
function paneRenderState(pane: FileBrowserPaneView) {
  return {
    fileEntries: pane.entries,
    currentPath: pane.path,
    isLoading: pane.loading,
    error: pane.error,
  };
}

/**
 * Unified file browser hook that delegates to local or session mode.
 * All hooks are always called to satisfy Rules of Hooks.
 *
 * The active pane and each pane's per-render UI state (listing, cwd, loading,
 * error) are sourced from the projected client-scoped `file-browser` region via
 * {@link useProjectedFileBrowsers} — the parity-safe render cut (#2228). The region
 * faithfully mirrors `appStore` (and falls back to it when it does not), so the
 * output is value-identical to the pre-cut path. The file *actions* still come from
 * the per-mode hooks, which keep reading `appStore` directly. Since the SFTP
 * convergence (#2313 / #2422) SSH browses through the session mode like every other
 * remote type — the legacy standalone SFTP browser is gone.
 */
export function useFileBrowser() {
  const projected = useProjectedFileBrowsers();
  const local = useLocalFileSystem();
  const session = useSessionFileSystem();

  if (projected.mode === "local") {
    return { ...local, ...paneRenderState(projected.local), mode: "local" as const };
  }

  if (projected.mode === "session") {
    return { ...session, ...paneRenderState(projected.session), mode: "session" as const };
  }

  // "none" mode — return disconnected defaults
  return {
    fileEntries: [],
    currentPath: "/",
    isConnected: false,
    isLoading: false,
    error: null,
    navigateTo: async () => {},
    navigateUp: async () => {},
    refresh: async () => {},
    downloadFile: async () => {},
    uploadFile: async () => {},
    uploadFileFromPath: async () => {},
    createDirectory: async () => {},
    createFile: async () => {},
    deleteEntry: async () => {},
    renameEntry: async () => {},
    openInVscode: async () => {},
    copyEntry: () => {},
    cutEntry: () => {},
    pasteEntry: async () => {},
    mode: "none" as const,
  };
}
