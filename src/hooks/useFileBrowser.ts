import { useAppStore } from "@/store/appStore";
import { useFileSystem } from "./useFileSystem";
import { useLocalFileSystem } from "./useLocalFileSystem";

/**
 * Unified file browser hook that delegates to local or SFTP based on mode.
 * Both hooks are always called to satisfy Rules of Hooks.
 */
export function useFileBrowser() {
  const fileBrowserMode = useAppStore((s) => s.fileBrowserMode);
  const sftp = useFileSystem();
  const local = useLocalFileSystem();

  if (fileBrowserMode === "local") {
    return { ...local, mode: "local" as const };
  }

  if (fileBrowserMode === "sftp") {
    return { ...sftp, mode: "sftp" as const };
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
    createDirectory: async () => {},
    deleteEntry: async () => {},
    renameEntry: async () => {},
    openInVscode: async () => {},
    mode: "none" as const,
  };
}
