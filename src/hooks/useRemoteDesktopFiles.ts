import { useCallback, useEffect, useRef, useState } from "react";
import { remoteDesktopFileChannel } from "@/services/api";
import { toast } from "@/components/ui";
import { uploadToRemoteDesktop } from "@/components/RemoteDesktop/fileTransfer";
import { useAppStore } from "@/store/appStore";
import { isPasswordPromptAbort } from "@/store/slices/passwordPromptSlice";
import { askLinkedSshSecret } from "@/utils/linkedSshSecret";
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
  /**
   * Re-resolve the route on a user action (popover open, Retry, a drop on a
   * route that is not ready). A linked SSH route without a saved secret
   * (#4265) asks for it here with the usual password prompt. Settles with
   * the new state, or `null` when the session went away meanwhile.
   */
  refresh: () => Promise<RemoteDesktopFilesStatus | null>;
  /** Upload local paths (a drop) into `dest` or the current folder. */
  uploadPaths: (paths: string[], dest?: string) => Promise<void>;
  /** Pick local files with the native dialog and upload them. */
  pickAndUpload: (dest?: string) => Promise<void>;
}

/**
 * How many times one user action may ask (an unlock, then the secret, then a
 * re-entry or two after a rejection) before it leaves the route degraded.
 */
const MAX_SECRET_ROUNDS = 4;

/** States in which the session is live and its route can be resolved. */
function isLive(state: GraphicalSessionState): boolean {
  return state === "active" || state === "resizing";
}

/**
 * The file side channel of one graphical session: resolved when the session
 * becomes Active and again after every reconnect (a new tunnel), plus the
 * upload actions. "Upload to folder…" choices are remembered for the session.
 * Those automatic resolutions never prompt; only {@link RemoteDesktopFiles.refresh},
 * run on a user action, asks for a linked SSH route's missing secret (#4265).
 * `onReveal` backs the upload summary's **Reveal** action (#4193).
 */
export function useRemoteDesktopFiles(
  sessionId: string | null,
  state: GraphicalSessionState,
  onReveal?: (dir: string) => void
): RemoteDesktopFiles {
  const [files, setFiles] = useState<RemoteDesktopFilesStatus>({ status: "resolving" });
  const [chosenDir, setChosenDir] = useState<string | null>(null);
  const live = sessionId !== null && isLive(state);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;

  // A new session starts with no remembered folder.
  useEffect(() => setChosenDir(null), [sessionId]);

  // Aborted when the session changes or the tab closes, so a password prompt
  // still queued for this session is dropped instead of outliving it (#4312).
  const promptAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    promptAbort.current = controller;
    return () => controller.abort();
  }, [sessionId]);

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
  }, [live, sessionId]);

  // One attended resolution at a time, so a popover open racing a drop never
  // opens a second prompt.
  const inflight = useRef<Promise<RemoteDesktopFilesStatus | null> | null>(null);
  const refresh = useCallback((): Promise<RemoteDesktopFilesStatus | null> => {
    if (inflight.current) return inflight.current;
    const id = sessionRef.current;
    if (!id) return Promise.resolve(null);
    const settle = (next: RemoteDesktopFilesStatus): RemoteDesktopFilesStatus | null => {
      if (sessionRef.current !== id) return null;
      setFiles(next);
      return next;
    };
    const run = (async (): Promise<RemoteDesktopFilesStatus | null> => {
      try {
        let answer = await remoteDesktopFileChannel(id);
        for (let round = 0; round < MAX_SECRET_ROUNDS; round++) {
          if (answer.status !== "degraded" || !answer.needsSecret) break;
          if (sessionRef.current !== id) return null;
          // Show the reason while the prompt is up; a cancel leaves it there.
          setFiles(answer);
          const outcome = await askLinkedSshSecret(
            answer.needsSecret,
            useAppStore.getState().requestPassword,
            promptAbort.current?.signal
          );
          if (outcome.status === "canceled") break;
          answer = await remoteDesktopFileChannel(
            id,
            outcome.status === "entered" ? outcome.secret : undefined
          );
        }
        return settle(answer);
      } catch (err) {
        // The tab closed or the session changed while the prompt was queued.
        if (isPasswordPromptAbort(err)) return null;
        frontendLog("remote_desktop_files", `file channel query failed: ${errorMessage(err)}`);
        return settle({ status: "error", message: errorMessage(err) });
      }
    })();
    inflight.current = run;
    void run.finally(() => {
      if (inflight.current === run) inflight.current = null;
    });
    return run;
  }, []);

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
