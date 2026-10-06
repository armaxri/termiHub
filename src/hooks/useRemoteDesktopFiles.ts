import { useCallback, useEffect, useRef, useState } from "react";
import { remoteDesktopFileChannel } from "@/services/api";
import { toast } from "@/components/ui";
import { uploadToRemoteDesktop } from "@/components/RemoteDesktop/fileTransfer";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import type { RemoteDesktopFileChannel } from "@/types/generated/RemoteDesktopFileChannel";
import type { GraphicalSessionState } from "@/types/remoteDesktop";

/**
 * Where a graphical session's file side channel stands (#4191/#4192): still
 * resolving, the backend's answer, or a failed query.
 */
export type RemoteDesktopFilesStatus =
  | { status: "resolving" }
  | RemoteDesktopFileChannel
  | { status: "error"; message: string };

/** What the drop overlay, toolbar and Files popover need. */
export interface RemoteDesktopFiles {
  files: RemoteDesktopFilesStatus;
  /** The folder uploads go to: the session's chosen folder, else the default. */
  destDir: string | null;
  /** Re-resolve the route (popover open, retry of a degraded route). */
  refresh: () => void;
  /** Upload local paths (a drop) into `dest` or the current folder. */
  uploadPaths: (paths: string[], dest?: string) => Promise<void>;
  /** Pick local files with the native dialog and upload them. */
  pickAndUpload: (dest?: string) => Promise<void>;
}

/** States in which the session is live and its route can be resolved. */
function isLive(state: GraphicalSessionState): boolean {
  return state === "active" || state === "resizing";
}

/**
 * The file side channel of one graphical session: resolved when the session
 * becomes Active and again after every reconnect (a new tunnel), plus the
 * upload actions. "Upload to folder…" choices are remembered for the session.
 * `onReveal` backs the upload summary's **Reveal** action (#4193).
 */
export function useRemoteDesktopFiles(
  sessionId: string | null,
  state: GraphicalSessionState,
  onReveal?: (dir: string) => void
): RemoteDesktopFiles {
  const [files, setFiles] = useState<RemoteDesktopFilesStatus>({ status: "resolving" });
  const [chosenDir, setChosenDir] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const live = sessionId !== null && isLive(state);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;

  // A new session starts with no remembered folder.
  useEffect(() => setChosenDir(null), [sessionId]);

  useEffect(() => {
    if (!live || !sessionId) {
      setFiles({ status: "resolving" });
      return;
    }
    let stale = false;
    // Deferred into the promise chain so a synchronous throw also lands in
    // the error state instead of escaping the effect.
    Promise.resolve()
      .then(() => remoteDesktopFileChannel(sessionId))
      .then((answer) => {
        if (!stale) setFiles(answer);
      })
      .catch((err) => {
        frontendLog("remote_desktop_files", `file channel query failed: ${errorMessage(err)}`);
        if (!stale) setFiles({ status: "error", message: errorMessage(err) });
      });
    return () => {
      stale = true;
    };
  }, [live, sessionId, generation]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  const destDir = files.status === "ready" ? (chosenDir ?? files.defaultDir) : null;

  const uploadPaths = useCallback(
    async (paths: string[], dest?: string) => {
      const id = sessionRef.current;
      if (!id || paths.length === 0) return;
      const reveal = revealRef.current;
      const started = await uploadToRemoteDesktop(
        id,
        paths,
        dest ?? chosenDir ?? undefined,
        reveal ? (dir) => reveal(dir) : undefined
      );
      // Remember an explicitly chosen folder once the backend accepted it.
      if (started && dest !== undefined) setChosenDir(started.destDir);
    },
    [chosenDir]
  );

  const pickAndUpload = useCallback(
    async (dest?: string) => {
      let picked: string | string[] | null;
      try {
        const { open } = await import("@/services/nativeDialog");
        picked = await open({ title: "Select files to upload", multiple: true });
      } catch (err) {
        toast.error(`Upload failed: ${errorMessage(err)}`);
        return;
      }
      if (!picked) return;
      await uploadPaths(Array.isArray(picked) ? picked : [picked], dest);
    },
    [uploadPaths]
  );

  return { files, destDir, refresh, uploadPaths, pickAndUpload };
}
