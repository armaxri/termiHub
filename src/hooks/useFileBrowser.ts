import { useAppStore } from "@/store/appStore";
import { useFileSystem } from "./useFileSystem";
import { useLocalFileSystem } from "./useLocalFileSystem";
import { useSessionFileSystem } from "./useSessionFileSystem";

/**
 * Unified file browser hook that delegates to local, SFTP, or session mode.
 * All hooks are always called to satisfy Rules of Hooks.
 */
export function useFileBrowser() {
  const fileBrowserMode = useAppStore((s) => s.fileBrowserMode);
  const sftp = useFileSystem();
  const local = useLocalFileSystem();
  const session = useSessionFileSystem();

  if (fileBrowserMode === "local") {
    return { ...local, mode: "local" as const };
  }

  if (fileBrowserMode === "sftp") {
    return { ...sftp, mode: "sftp" as const };
  }

  if (fileBrowserMode === "session") {
    return { ...session, mode: "session" as const };
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
