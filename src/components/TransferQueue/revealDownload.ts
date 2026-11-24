import { toast } from "@/components/ui";
import { localOpenFolder } from "@/services/api";
import type { TransferEntry } from "@/types/transfer";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { parentDir } from "@/utils/paths";
import { fileManagerActionLabel } from "@/utils/platform";

/**
 * "Reveal in Finder" for a finished download (#5834, R-033).
 *
 * A download the user saved somewhere records that destination on its Transfer
 * Queue row (`localPath`). Once the row is `completed`, the transfer feedback
 * offers to open the folder holding the file in the OS file manager, worded per
 * platform ("Reveal in Finder" / "Show in File Explorer" / "Open in File
 * Manager"). It opens the folder through the validated `local_open_folder`
 * command, the same way the backup dialog reveals a saved backup.
 */

/** The local file a finished download wrote, or `null` when there is none to show. */
export function revealableDownloadPath(entry: TransferEntry): string | null {
  if (entry.direction !== "download" || entry.state !== "completed") return null;
  return entry.localPath ? entry.localPath : null;
}

/**
 * The most recently finished download of `entries` that can be revealed, or
 * `null`. Rows are ordered by their last update, so this is the download that
 * just finished.
 */
export function latestRevealableDownload(entries: readonly TransferEntry[]): TransferEntry | null {
  let latest: TransferEntry | null = null;
  for (const entry of entries) {
    if (revealableDownloadPath(entry) === null) continue;
    if (latest === null || entry.updatedAt > latest.updatedAt) latest = entry;
  }
  return latest;
}

/** The platform's wording for the reveal action. */
export function revealDownloadLabel(): string {
  return fileManagerActionLabel();
}

/**
 * Open the folder holding `localPath` in the OS file manager. A failure (the
 * file was moved, the folder deleted) is reported, never swallowed.
 */
export function revealDownload(localPath: string): void {
  localOpenFolder(parentDir(localPath)).catch((err: unknown) => {
    frontendLog("transfers", `Reveal download failed: ${errorMessage(err)}`);
    toast.error(`Could not open the folder: ${errorMessage(err)}`);
  });
}
