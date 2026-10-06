/**
 * File transfer to a graphical session's side channel (#3770 phase 2, #4192):
 * the copy every surface shows (drop overlay, Files popover, toasts) and the
 * upload flow behind a drop or "Upload files…".
 *
 * Wording rule from the concept: the destination always names the host the
 * bytes actually land on (`channel.host`) — never the desktop host when the two
 * differ.
 */

import { toast } from "@/components/ui";
import { remoteDesktopUpload } from "@/services/api";
import { onTransferProgress } from "@/services/events";
import { seedTransferQueueRow } from "@/hooks/transferFeedback";
import { errorMessage } from "@/utils/errorMessage";
import type { FileChannelUnavailable } from "@/types/generated/FileChannelUnavailable";
import type { FileSideChannel } from "@/types/generated/FileSideChannel";
import type { RemoteDesktopUploadStarted } from "@/types/generated/RemoteDesktopUploadStarted";

/** `1 file` / `3 files`. */
export function countLabel(count: number, noun = "file"): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The last path segment of a local path (either separator). */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** What a drop of `paths` uploads: the one name, or a count. */
export function dropSubject(paths: string[]): string {
  return paths.length === 1 ? baseName(paths[0]) : countLabel(paths.length);
}

/** `user@host`, or just the host when the account is unknown. */
function account(channel: FileSideChannel): string {
  return channel.user ? `${channel.user}@${channel.host}` : channel.host;
}

/**
 * The carrier line of the drop overlay: "via SFTP over the SSH tunnel
 * (arne@tiger-box)" or "via the termiHub agent on lab-pi".
 */
export function routeVia(channel: FileSideChannel): string {
  return channel.kind === "agent"
    ? `via the termiHub agent on ${channel.host}`
    : `via SFTP over the SSH tunnel (${account(channel)})`;
}

/**
 * The carrier half of the popover's route line, the trust statement:
 * "SFTP via SSH tunnel (host key verified)" or "termiHub agent".
 */
export function routeCarrier(channel: FileSideChannel): string {
  return channel.kind === "agent"
    ? `termiHub agent (${account(channel)})`
    : `SFTP via SSH tunnel (${account(channel)}, host key verified)`;
}

/** Why there is no file transfer, as a heading + how to enable it. */
export interface UnavailableCopy {
  title: string;
  hint: string;
}

/** The copy for an `unavailable` channel. */
export function unavailableCopy(reason: FileChannelUnavailable): UnavailableCopy {
  const title = "File transfer isn't available here";
  switch (reason) {
    case "viewOnly":
      return { title, hint: "View-only session — files can't be sent to the remote host." };
    case "disabled":
      return {
        title,
        hint: "File transfer is off for this connection. Turn on File Transfer in the connection settings.",
      };
    case "noRoute":
    default:
      return {
        title,
        hint: "VNC has no portable file transfer. Enable the SSH Tunnel (or host this connection under an agent) and turn on File Transfer in the connection settings.",
      };
  }
}

/** How the queued uploads of one drop ended. */
interface Settlement {
  done: number;
  failed: number;
  cancelled: number;
}

/**
 * Listen for the terminal `transfer-progress` phase of the given ids. Start
 * listening **before** the uploads are queued so a fast transfer cannot settle
 * unseen; `track` names the ids once known.
 */
async function watchSettlement(): Promise<{
  track: (ids: string[]) => Promise<Settlement>;
  stop: () => void;
}> {
  const outcome = new Map<string, "done" | "error" | "cancelled">();
  let wanted: Set<string> | null = null;
  let finish: (() => void) | null = null;
  const unlisten = await onTransferProgress((p) => {
    if (p.phase !== "done" && p.phase !== "error" && p.phase !== "cancelled") return;
    outcome.set(p.transferId, p.phase);
    if (wanted && [...wanted].every((id) => outcome.has(id))) finish?.();
  });
  const track = (ids: string[]) =>
    new Promise<Settlement>((resolve) => {
      wanted = new Set(ids);
      const settle = () => {
        unlisten();
        const phases = ids.map((id) => outcome.get(id));
        resolve({
          done: phases.filter((p) => p === "done").length,
          failed: phases.filter((p) => p === "error").length,
          cancelled: phases.filter((p) => p === "cancelled").length,
        });
      };
      finish = settle;
      if (ids.every((id) => outcome.has(id))) settle();
    });
  return { track, stop: unlisten };
}

/** "N skipped (reason)" for the toast description, or `undefined`. */
function skippedNote(started: RemoteDesktopUploadStarted): string | undefined {
  const skipped = started.skipped;
  if (skipped.length === 0) return undefined;
  const reasons = [...new Set(skipped.map((s) => s.reason))].join("; ");
  return `${skipped.length} skipped (${reasons})`;
}

/**
 * Upload `paths` to a graphical session's side channel with feedback all the
 * way: a pending toast while the uploads are queued and run, then one summary
 * ("Uploaded 2 files to /home/arne/Desktop on tiger-box"). Each file is a
 * Transfers-queue row keyed by the session. Resolves with what was queued, or
 * `null` when the backend refused the upload (the error is toasted).
 */
export async function uploadToRemoteDesktop(
  sessionId: string,
  paths: string[],
  dest?: string
): Promise<RemoteDesktopUploadStarted | null> {
  const toastId = toast.loading(`Uploading ${dropSubject(paths)}…`, {
    testId: "remote-desktop-upload-toast",
  });
  const watch = await watchSettlement();
  let started: RemoteDesktopUploadStarted;
  try {
    started = await remoteDesktopUpload(sessionId, paths, dest);
  } catch (err) {
    watch.stop();
    toast.error(`Upload failed: ${errorMessage(err)}`, {
      id: toastId,
      testId: "remote-desktop-upload-toast",
    });
    return null;
  }
  for (const t of started.transfers) {
    seedTransferQueueRow({
      transferId: t.transferId,
      sessionId,
      direction: "upload",
      remotePath: t.remotePath,
    });
  }
  const where = `${started.destDir} on ${started.host}`;
  const total = started.transfers.length;
  if (total === 0) {
    watch.stop();
    const opts = { id: toastId, description: skippedNote(started) };
    if (started.folders > 0) {
      toast.success(`Created ${countLabel(started.folders, "folder")} in ${where}`, opts);
    } else {
      toast.error(`Nothing was uploaded to ${where}`, opts);
    }
    return started;
  }
  toast.loading(`Uploading ${countLabel(total)} to ${where}…`, {
    id: toastId,
    testId: "remote-desktop-upload-toast",
  });
  void watch.track(started.transfers.map((t) => t.transferId)).then((result) => {
    const description = skippedNote(started);
    if (result.failed > 0) {
      toast.error(`Uploaded ${result.done} of ${countLabel(total)} to ${where}`, {
        id: toastId,
        description: `${result.failed} failed — see Transfers${description ? `; ${description}` : ""}`,
        testId: "remote-desktop-upload-toast",
      });
    } else if (result.done === 0) {
      toast.dismiss(toastId);
    } else {
      toast.success(`Uploaded ${countLabel(result.done)} to ${where}`, {
        id: toastId,
        description,
        testId: "remote-desktop-upload-toast",
      });
    }
  });
  return started;
}
