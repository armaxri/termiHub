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
  localCopyStart,
  vscodeOpenLocal,
  LOCAL_TRANSFER_SESSION,
} from "@/services/api";
import { FileEntry } from "@/types/connection";
import {
  pickPathOrReport,
  runMaybeTrackedTransfer,
  seedTransferQueueRow,
} from "./transferFeedback";
import { toast } from "@/components/ui";
import {
  describeEntries,
  joinDirPath,
  pasteVerbLabels,
  type PasteOptions,
} from "@/utils/fileDragMove";

/** How many skipped paths a toast names before summarising the rest. */
const SKIPPED_NAMED = 3;

/** Toast text for a folder copy's skipped special files (#3605). */
function describeSkipped(skipped: string[]): string {
  const n = skipped.length;
  const named = skipped.slice(0, SKIPPED_NAMED).join(", ");
  const rest = n > SKIPPED_NAMED ? ` and ${n - SKIPPED_NAMED} more` : "";
  return `Skipped ${n} special file${n === 1 ? "" : "s"} (sockets, pipes or devices): ${named}${rest}`;
}

/**
 * Start a local copy of `srcPath` to `destPath` (PARITY-004 #3567, folders
 * #3605): a large file — or each large file of a folder — runs through the
 * transfer queue with its own row seeded under {@link LOCAL_TRANSFER_SESSION};
 * small files, folders and symlinks are copied directly, and a folder's
 * skipped special files are reported. Resolves to whether the queue tracked
 * any of it.
 */
function copyLocal(srcPath: string, destPath: string): Promise<boolean> {
  return localCopyStart(
    srcPath,
    destPath,
    (transferId, fileSrcPath) =>
      seedTransferQueueRow({
        transferId,
        sessionId: LOCAL_TRANSFER_SESSION,
        direction: "download",
        remotePath: fileSrcPath,
      }),
    (skipped) => toast.info(describeSkipped(skipped))
  );
}

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
      // An OS drop onto the local pane: a large file is a queued copy whose event
      // path owns the terminal toast, a small one a direct copy we toast here.
      const ok = await runMaybeTrackedTransfer(
        `Copy "${fileName}"`,
        () => copyLocal(localPath, destPath),
        { loading: `Copying ${fileName}…`, success: `Copied ${fileName}` }
      );
      if (ok) void refreshLocal();
    },
    [currentPath, refreshLocal]
  );

  const downloadFile = useCallback(async (filePath: string, fileName: string) => {
    const localPath = await pickPathOrReport(`Save "${fileName}"`, () =>
      save({ title: "Save file as...", defaultPath: fileName })
    );
    if (!localPath) return;
    // A local Save-as: a large file is a queued copy (the backend also detects a
    // folder and copies it directly); a direct copy owns its feedback (UX-017).
    await runMaybeTrackedTransfer(`Save "${fileName}"`, () => copyLocal(filePath, localPath), {
      loading: `Saving ${fileName}…`,
      success: `Saved ${fileName}`,
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

      // A rename or a small/folder copy is a blocking round-trip with no
      // transfer-progress event, so own the loading → success/error feedback here
      // (#3458) — one summary toast for the whole paste. A large file copy runs
      // through the transfer queue (#3567), whose event path then owns the
      // terminal toast. The first failure aborts the rest, and the rejection is
      // swallowed so no caller sees an unhandled rejection.
      const ok = await runMaybeTrackedTransfer(
        `${verb} ${what}`,
        async () => {
          let tracked = false;
          for (const clipEntry of clipboard.entries) {
            const destPath = joinDirPath(destDir, clipEntry.name);
            if (clipboard.operation === "cut") {
              await localRename(clipEntry.path, destPath);
            } else {
              tracked = (await copyLocal(clipEntry.path, destPath)) || tracked;
            }
          }
          return tracked;
        },
        { loading: `${labels.loading} ${what}…`, success: `${labels.done} ${what}${where}` }
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
    // Local rows have real paths, so they can always be dragged out (#3457).
    supportsDragOut: true,
    openInVscode,
    copyEntry,
    cutEntry,
    pasteEntry,
  };
}
