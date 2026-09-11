import { useEffect, useId, useRef } from "react";
import { watchLocalDir, unwatchLocalDir } from "@/services/api";
import { onLocalDirChanged } from "@/services/events";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Coalesce a burst of directory events into a single refresh on the frontend
 * too — belt-and-braces over the backend's own debounce, so a recursive copy or
 * multi-file operation triggers one re-list, not a storm.
 */
const REFRESH_DEBOUNCE_MS = 150;

/**
 * Watch a **local** directory for external on-disk changes and refresh the
 * listing when a direct child is added / removed / renamed / modified (#1626).
 *
 * Reuses the backend `FileWatchManager` directory-watch that #1620 introduced
 * for editor files. One OS watch per browser instance (keyed off a stable
 * `useId`) is torn down on unmount and re-targeted whenever `path` changes, so
 * navigating never leaks a watch. The watcher is event-driven; the toolbar
 * Refresh button remains as a manual backstop (there is no competing poll in the
 * app — the directory was previously only re-read on navigation/refresh).
 *
 * Local only: remote (SFTP / session) browsers use their own transports and must
 * not OS-watch a remote path (that is #1627).
 *
 * @param enabled Whether watching is active (false in non-local browser modes).
 * @param path The absolute local directory to watch, or `null` to watch nothing.
 * @param onExternalChange Called (debounced) when the directory's entries change.
 */
export function useLocalDirWatch(
  enabled: boolean,
  path: string | null,
  onExternalChange: () => void
): void {
  const watchId = useId();

  // A monotonic per-effect-run counter. Combined with the stable `watchId` it
  // gives every watch registration a unique id, so a slow-to-register watch
  // from a superseded run only ever unwatches *its own* registration and can
  // never tear down the current run's watch that reuses the base id (FEC-005).
  const watchRunRef = useRef(0);

  // Keep a stable ref so the (path-scoped) watch effect always calls the latest
  // refresh logic without re-subscribing when the callback identity changes.
  const onChangeRef = useRef(onExternalChange);
  onChangeRef.current = onExternalChange;

  useEffect(() => {
    if (!enabled || !path) return;
    const runWatchId = `${watchId}:${watchRunRef.current++}`;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let registered = false;
    let watchClosed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    // Idempotently tear down the OS watch — but only once it has actually
    // registered. Calling `unwatchLocalDir` before the matching
    // `watchLocalDir` resolves would race ahead of it and leak the OS watcher
    // (FEC-005). `closeWatch` is a no-op until registration completes; the
    // start path calls it once registration lands if teardown got there first.
    const closeWatch = () => {
      if (watchClosed || !registered) return;
      watchClosed = true;
      void unwatchLocalDir(runWatchId).catch(() => {
        // best-effort teardown
      });
    };

    const start = async () => {
      try {
        await watchLocalDir(runWatchId, path);
        registered = true;
      } catch (err) {
        frontendLog(
          "file_browser",
          `failed to start local dir watch for ${path}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }
      // Torn down while the watch was registering: cleanup could not unwatch a
      // watch that did not exist yet, so unwatch it now that it does.
      if (disposed) {
        closeWatch();
        return;
      }
      const off = await onLocalDirChanged((changedWatchId) => {
        if (changedWatchId !== runWatchId) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          onChangeRef.current();
        }, REFRESH_DEBOUNCE_MS);
      });
      // The effect may have been torn down while awaiting the listener; drop it
      // and tear the (now-registered) watch down.
      if (disposed) {
        off();
        closeWatch();
      } else {
        unlisten = off;
      }
    };
    void start();

    return () => {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      unlisten?.();
      closeWatch();
    };
  }, [enabled, path, watchId]);
}
