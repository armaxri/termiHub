import { useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import { useProjectedFileBrowsers } from "@/store/useProjectedFileBrowsers";
import {
  localMkdir,
  localDelete,
  localRename,
  localSetPermissions,
  localSetOwner,
  localCreateSymlink,
  localWriteFile,
  localCopyFile,
  vscodeOpenLocal,
} from "@/services/api";
import { FileEntry } from "@/types/connection";
import { pickPathOrReport, runBlockingTransfer } from "./transferFeedback";
import { toast } from "@/components/ui";
import {
  describeEntries,
  joinDirPath,
  pasteVerbLabels,
  type PasteOptions,
} from "@/utils/fileDragMove";

/**
 * Hook for local filesystem operations.
 * Same shape as useFileSystem for SFTP.
 *
 * The local pane's view (listing, cwd, loading, error) is sourced from the
 * authoritative `file-browser` projection region (#2283) via
 * {@link useProjectedFileBrowsers}; the file *actions* dispatch through the
 * `appStore` file-browser actions, which report each transition to the region.
 */
export function useLocalFileSystem() {
  const local = useProjectedFileBrowsers().local;
  const fileEntries = local.entries;
  const currentPath = local.path;
  const isLoading = local.loading;
  const error = local.error;
  const navigateLocal = useAppStore((s) => s.navigateLocal);
  const refreshLocal = useAppStore((s) => s.refreshLocal);
  const clearFileBrowserError = useAppStore((s) => s.clearFileBrowserError);

  const navigateTo = useCallback(
    (path: string) => {
      navigateLocal(path);
    },
    [navigateLocal]
  );

  const navigateUp = useCallback(() => {
    if (currentPath === "/") return;
    // Windows drive root (e.g. "C:/" or "C:"): nothing above this
    if (/^[A-Za-z]:\/?$/.test(currentPath)) return;
    // Remove any trailing slash, then strip the last path segment
    const noTrailing = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
    const parts = noTrailing.split("/");
    parts.pop();
    let parentPath = parts.join("/") || "/";
    // A bare drive letter like "C:" becomes the drive root "C:/"
    if (/^[A-Za-z]:$/.test(parentPath)) {
      parentPath = parentPath + "/";
    }
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  // Return the promise so a Retry Button can drive its async pending state.
  const refresh = useCallback(() => refreshLocal(), [refreshLocal]);

  const dismissError = useCallback(() => clearFileBrowserError("local"), [clearFileBrowserError]);

  const createDirectory = useCallback(
    async (name: string) => {
      const base = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
      const dirPath = base ? `${base}/${name}` : `/${name}`;
      await localMkdir(dirPath);
      refreshLocal();
    },
    [currentPath, refreshLocal]
  );

  const createFile = useCallback(
    async (name: string) => {
      const base = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
      const filePath = base ? `${base}/${name}` : `/${name}`;
      await localWriteFile(filePath, "");
      refreshLocal();
    },
    [currentPath, refreshLocal]
  );

  const deleteEntry = useCallback(
    async (path: string, isDirectory: boolean) => {
      await localDelete(path, isDirectory);
      refreshLocal();
    },
    [refreshLocal]
  );

  const renameEntry = useCallback(
    async (oldPath: string, newName: string) => {
      const parentDir = oldPath.split("/").slice(0, -1).join("/") || "/";
      const newPath = parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`;
      await localRename(oldPath, newPath);
      refreshLocal();
    },
    [refreshLocal]
  );

  const setPermissions = useCallback(
    async (path: string, mode: number) => {
      await localSetPermissions(path, mode);
      refreshLocal();
    },
    [refreshLocal]
  );

  const setOwner = useCallback(
    async (path: string, uid: number | null, gid: number | null) => {
      await localSetOwner(path, uid, gid);
      refreshLocal();
    },
    [refreshLocal]
  );

  const createSymlink = useCallback(
    async (target: string, linkName: string) => {
      const base = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
      const linkPath = base ? `${base}/${linkName}` : `/${linkName}`;
      await localCreateSymlink(target, linkPath);
      refreshLocal();
    },
    [currentPath, refreshLocal]
  );

  const openInVscode = useCallback(async (path: string) => {
    await vscodeOpenLocal(path);
  }, []);

  const uploadFileFromPath = useCallback(
    async (localPath: string) => {
      const parts = localPath.replace(/\\/g, "/").split("/");
      const fileName = parts[parts.length - 1] || "file";
      const base = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
      const destPath = base ? `${base}/${fileName}` : `/${fileName}`;
      if (localPath === destPath) return;
      // An OS drop onto the local pane is a blocking copy with no transfer event;
      // own its feedback so a failure never becomes a silent unhandled rejection.
      const ok = await runBlockingTransfer(() => localCopyFile(localPath, destPath, false), {
        loading: `Copying ${fileName}…`,
        success: `Copied ${fileName}`,
        errorLabel: `Copy "${fileName}"`,
      });
      if (ok) void refreshLocal();
    },
    [currentPath, refreshLocal]
  );

  const downloadFile = useCallback(async (filePath: string, fileName: string) => {
    const localPath = await pickPathOrReport(`Save "${fileName}"`, () =>
      save({ title: "Save file as...", defaultPath: fileName })
    );
    if (!localPath) return;
    const isDir =
      currentFileBrowsersView().local.entries.find((e) => e.path === filePath)?.isDirectory ??
      false;
    // A local Save-as copy is a blocking round-trip with no transfer-progress
    // event, so surface its own feedback (UX-017) rather than resolving silently.
    await runBlockingTransfer(() => localCopyFile(filePath, localPath, isDir), {
      loading: `Saving ${fileName}…`,
      success: `Saved ${fileName}`,
      errorLabel: `Save "${fileName}"`,
    });
  }, []);

  const copyEntry = useCallback(
    (entries: FileEntry[]) => {
      useAppStore.getState().setFileClipboard({
        entries,
        operation: "copy",
        sourceMode: "local",
        sourcePath: currentPath,
      });
    },
    [currentPath]
  );

  const cutEntry = useCallback(
    (entries: FileEntry[]) => {
      useAppStore.getState().setFileClipboard({
        entries,
        operation: "cut",
        sourceMode: "local",
        sourcePath: currentPath,
      });
    },
    [currentPath]
  );

  const pasteEntry = useCallback(
    async (options?: PasteOptions) => {
      // An explicit clipboard (drag-to-move / Move to… dialog) is a one-shot
      // transfer that never touches — or clears — the user's copy/cut clipboard.
      const clipboard = options?.clipboard ?? currentFileBrowsersView().clipboard;
      if (!clipboard) return;

      if (clipboard.sourceMode !== "local") {
        // A session→local paste is not supported here (the remote source lives on
        // the session transport, not the local disk); the session pane handles its
        // own paste. The legacy sftp→local download path was retired with the
        // standalone SFTP browser (#2422). Say so instead of doing nothing.
        toast.error("Pasting remote items into a local folder is not supported");
        return;
      }

      const destDir = options?.destDir ?? currentPath;
      const verb = options?.verb ?? "Paste";
      const labels = pasteVerbLabels(verb);
      const what = describeEntries(clipboard.entries);
      const where = options?.destDir ? ` to ${destDir}` : "";

      // A local rename/copy is a blocking round-trip with no transfer-progress
      // event, so own the loading → success/error feedback here (#3458) — one
      // summary toast for the whole paste. The first failure aborts the rest,
      // and the rejection is swallowed so no caller sees an unhandled rejection.
      const ok = await runBlockingTransfer(
        async () => {
          for (const clipEntry of clipboard.entries) {
            const destPath = joinDirPath(destDir, clipEntry.name);
            if (clipboard.operation === "cut") {
              await localRename(clipEntry.path, destPath);
            } else {
              await localCopyFile(clipEntry.path, destPath, clipEntry.isDirectory);
            }
          }
        },
        {
          loading: `${labels.loading} ${what}…`,
          success: `${labels.done} ${what}${where}`,
          errorLabel: `${verb} ${what}`,
        }
      );

      // Keep a cut clipboard after a failure so the user can retry.
      if (ok && clipboard.operation === "cut" && !options?.clipboard) {
        useAppStore.getState().setFileClipboard(null);
      }

      // Refresh either way: a partial paste may already have changed the folder.
      void refreshLocal();
    },
    [currentPath, refreshLocal]
  );

  return {
    fileEntries,
    currentPath,
    isConnected: true,
    isLoading,
    error,
    navigateTo,
    navigateUp,
    refresh,
    dismissError,
    downloadFile,
    uploadFile: async () => {
      /* no-op: files are already local */
    },
    uploadFileFromPath,
    createDirectory,
    createFile,
    deleteEntry,
    renameEntry,
    setPermissions,
    setOwner,
    createSymlink,
    // A local desktop host is the machine the user runs on; chmod / chown / symlink
    // are meaningful there (the backend still rejects them on non-Unix, and each
    // row only offers the permission-dependent actions when it carries a permission
    // string — i.e. on Unix).
    supportsPermissions: true,
    supportsOwner: true,
    supportsSymlink: true,
    openInVscode,
    copyEntry,
    cutEntry,
    pasteEntry,
  };
}
