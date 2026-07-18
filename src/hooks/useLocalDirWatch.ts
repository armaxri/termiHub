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

  // Keep a stable ref so the (path-scoped) watch effect always calls the latest
  // refresh logic without re-subscribing when the callback identity changes.
  const onChangeRef = useRef(onExternalChange);
  onChangeRef.current = onExternalChange;

  useEffect(() => {
    if (!enabled || !path) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const start = async () => {
      try {
        await watchLocalDir(watchId, path);
      } catch (err) {
        frontendLog(
          "file_browser",
          `failed to start local dir watch for ${path}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      const off = await onLocalDirChanged((changedWatchId) => {
        if (changedWatchId !== watchId) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          onChangeRef.current();
        }, REFRESH_DEBOUNCE_MS);
      });
      // The effect may have been torn down while awaiting; drop the listener.
      if (disposed) {
        off();
      } else {
        unlisten = off;
      }
    };
    void start();

    return () => {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      unlisten?.();
      void unwatchLocalDir(watchId).catch(() => {
        // best-effort teardown
      });
    };
  }, [enabled, path, watchId]);
}
