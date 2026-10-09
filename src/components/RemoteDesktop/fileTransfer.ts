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
import {
  claimBatchTransfers,
  openBatchWindow,
  releaseBatchTransfers,
} from "@/hooks/batchTransferToasts";
import { errorMessage } from "@/utils/errorMessage";
import type { FileChannelUnavailable } from "@/types/generated/FileChannelUnavailable";
import type { FileSideChannel } from "@/types/generated/FileSideChannel";
import type { RemoteDesktopUploadStarted } from "@/types/generated/RemoteDesktopUploadStarted";
import { getBasename } from "@/utils/paths";

/** `1 file` / `3 files`. */
export function countLabel(count: number, noun = "file"): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What a drop of `paths` uploads: the one name, or a count. */
export function dropSubject(paths: string[]): string {
  return paths.length === 1 ? getBasename(paths[0]) : countLabel(paths.length);
}

/** `user@host`, or just the host when the account is unknown. */
function account(channel: FileSideChannel): string {
  return channel.user ? `${channel.user}@${channel.host}` : channel.host;
}

/**
 * The carrier line of the drop overlay: "via SFTP over the SSH tunnel
 * (arne@tiger-box)", "via SFTP over the linked SSH connection Tiger
 * (arne@tiger-box)" (#4194) or "via the termiHub agent on lab-pi".
 */
export function routeVia(channel: FileSideChannel): string {
  if (channel.kind === "agent") return `via the termiHub agent on ${channel.host}`;
  return channel.linkedConnection
    ? `via SFTP over the linked SSH connection ${channel.linkedConnection} (${account(channel)})`
    : `via SFTP over the SSH tunnel (${account(channel)})`;
}

/**
 * The carrier half of the popover's route line, the trust statement:
 * "SFTP via SSH tunnel (host key verified)", "SFTP via the linked SSH
 * connection Tiger (…, host key verified)" or "termiHub agent".
 */
export function routeCarrier(channel: FileSideChannel): string {
  if (channel.kind === "agent") return `termiHub agent (${account(channel)})`;
  return channel.linkedConnection
    ? `SFTP via the linked SSH connection ${channel.linkedConnection} (${account(channel)}, host key verified)`
    : `SFTP via SSH tunnel (${account(channel)}, host key verified)`;
}

/**
 * The File Browser header's route line for a side channel (#4193):
 * "arne@tiger-box · SFTP via SSH tunnel", "arne@tiger-box · SFTP via the
 * linked SSH connection Tiger" (#4194) or "pi@lab-pi · termiHub agent".
 */
export function browseRoute(channel: FileSideChannel): string {
  const carrier =
    channel.kind === "agent"
      ? "termiHub agent"
      : channel.linkedConnection
        ? `SFTP via the linked SSH connection ${channel.linkedConnection}`
        : "SFTP via SSH tunnel";
  return `${account(channel)} · ${carrier}`;
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
    case "notOffered":
      // Never shown: the UI hides the feature for such a type (#4348).
      return { title, hint: "This connection type has no side-channel file transfer." };
    case "noRoute":
    default:
      return {
        title,
        hint: "VNC has no portable file transfer. Enable the SSH Tunnel (or host this connection under an agent), or link a saved SSH connection under File Transfer in the connection settings.",
      };
  }
}

/** How the queued uploads of one drop ended. */
interface Settlement {
  done: number;
  failed: number;
  cancelled: number;
  /**
   * Uploads with no terminal phase when the watch gave up: no event for any of
   * them within {@link SETTLEMENT_IDLE_MS} (paused, dropped from the registry,
   * an event missed), or the session closed. `0` when all settled.
   */
  unsettled: number;
}

/**
 * How long the summary waits without any `transfer-progress` event of its
 * uploads before it stops watching and points to Transfers instead (#4348):
 * an inactivity bound, so a long but progressing upload is never cut off.
 */
export const SETTLEMENT_IDLE_MS = 120_000;

/**
 * Listen for the terminal `transfer-progress` phase of the given ids. Start
 * listening **before** the uploads are queued so a fast transfer cannot settle
 * unseen; `track` names the ids once known. The watch ends when every id
 * settled, after {@link SETTLEMENT_IDLE_MS} without an event of the tracked ids,
 * or when `signal` aborts (the session closed) — the listener never outlives
 * it (#4348, FEC2-004).
 */
async function watchSettlement(signal?: AbortSignal): Promise<{
  track: (ids: string[]) => Promise<Settlement>;
  stop: () => void;
}> {
  const outcome = new Map<string, "done" | "error" | "cancelled">();
  let wanted: Set<string> | null = null;
  let finish: (() => void) | null = null;
  let idle: (() => void) | null = null;
  const unlisten = await onTransferProgress((p) => {
    if (wanted?.has(p.transferId)) idle?.();
    if (p.phase !== "done" && p.phase !== "error" && p.phase !== "cancelled") return;
    outcome.set(p.transferId, p.phase);
    if (wanted && [...wanted].every((id) => outcome.has(id))) finish?.();
  });
  let listening = true;
  const stop = () => {
    if (!listening) return;
    listening = false;
    unlisten();
  };
  const track = (ids: string[]) =>
    new Promise<Settlement>((resolve) => {
      wanted = new Set(ids);
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", settle);
        stop();
        const phases = ids.map((id) => outcome.get(id));
        resolve({
          done: phases.filter((p) => p === "done").length,
          failed: phases.filter((p) => p === "error").length,
          cancelled: phases.filter((p) => p === "cancelled").length,
          unsettled: phases.filter((p) => p === undefined).length,
        });
      };
      finish = settle;
      idle = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(settle, SETTLEMENT_IDLE_MS);
      };
      if (ids.every((id) => outcome.has(id)) || signal?.aborted) {
        settle();
        return;
      }
      signal?.addEventListener("abort", settle);
      idle();
    });
  return { track, stop };
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
 * Transfers-queue row keyed by the session; the summary replaces the per-file
 * toasts (#4348). With `onReveal`, the summary offers **Reveal** (opens Browse
 * remote files at the destination, #4193). `signal` ends the wait for the
 * summary (the session closed); like a stalled upload, that resolves the toast
 * to a neutral "see Transfers". Resolves with what was queued, or `null` when
 * the upload could not be started (the error is toasted).
 */
export async function uploadToRemoteDesktop(
  sessionId: string,
  paths: string[],
  dest?: string,
  onReveal?: (dir: string) => void,
  signal?: AbortSignal
): Promise<RemoteDesktopUploadStarted | null> {
  const toastId = toast.loading(`Uploading ${dropSubject(paths)}…`, {
    testId: "remote-desktop-upload-toast",
  });
  // Until the ids are known, uploads settling on this session belong to this
  // batch: no per-file toasts for them.
  const closeWindow = openBatchWindow(sessionId);
  let watch: Awaited<ReturnType<typeof watchSettlement>> | null = null;
  let started: RemoteDesktopUploadStarted;
  try {
    watch = await watchSettlement(signal);
    started = await remoteDesktopUpload(sessionId, paths, dest);
  } catch (err) {
    closeWindow();
    watch?.stop();
    toast.error(`Upload failed: ${errorMessage(err)}`, {
      id: toastId,
      testId: "remote-desktop-upload-toast",
    });
    return null;
  }
  const ids = started.transfers.map((t) => t.transferId);
  claimBatchTransfers(ids);
  closeWindow();
  for (const t of started.transfers) {
    seedTransferQueueRow({
      transferId: t.transferId,
      sessionId,
      direction: "upload",
      remotePath: t.remotePath,
    });
  }
  const where = `${started.destDir} on ${started.host}`;
  const reveal = onReveal
    ? { label: "Reveal", onClick: () => onReveal(started.destDir) }
    : undefined;
  const total = started.transfers.length;
  if (total === 0) {
    watch.stop();
    const opts = { id: toastId, description: skippedNote(started) };
    if (started.folders > 0) {
      toast.success(`Created ${countLabel(started.folders, "folder")} in ${where}`, {
        ...opts,
        action: reveal,
      });
    } else {
      toast.error(`Nothing was uploaded to ${where}`, opts);
    }
    return started;
  }
  toast.loading(`Uploading ${countLabel(total)} to ${where}…`, {
    id: toastId,
    testId: "remote-desktop-upload-toast",
  });
  void watch.track(ids).then((result) => {
    const description = skippedNote(started);
    if (result.unsettled > 0) {
      // The watch gave up (stalled, or the session closed): the rows in
      // Transfers carry on, so point there instead of spinning forever. The
      // per-file toast covers any upload that still settles later.
      releaseBatchTransfers(ids);
      const parts = [
        `${result.done} of ${countLabel(total)} done so far`,
        result.failed > 0 ? `${result.failed} failed` : null,
        description ?? null,
      ].filter(Boolean);
      toast.info(`Upload to ${where} — see Transfers`, {
        id: toastId,
        description: parts.join("; "),
        testId: "remote-desktop-upload-toast",
      });
    } else if (result.failed > 0) {
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
        action: reveal,
        testId: "remote-desktop-upload-toast",
      });
    }
  });
  return started;
}
