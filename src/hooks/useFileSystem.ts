import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";

/**
 * Hook for file system operations.
 * Phase 1: Uses mock data. Phase 3 will wire to SFTP backend.
 */
export function useFileSystem() {
  const fileEntries = useAppStore((s) => s.fileEntries);
  const currentPath = useAppStore((s) => s.currentPath);
  const setCurrentPath = useAppStore((s) => s.setCurrentPath);

  const navigateTo = useCallback(
    (path: string) => {
      setCurrentPath(path);
      // Phase 3: will call Tauri command to list directory
    },
    [setCurrentPath]
  );

  const navigateUp = useCallback(() => {
    const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  return { fileEntries, currentPath, navigateTo, navigateUp };
}
