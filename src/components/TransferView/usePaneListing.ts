import { useCallback, useEffect, useRef, useState } from "react";
import { getHomeDir, localListDir, sessionListFiles } from "@/services/api";
import type { PaneSide } from "@/services/paneTransfer";
import type { FileEntry } from "@/types/connection";
import { errorMessage } from "@/utils/errorMessage";
import { sortEntries } from "@/utils/fileBrowserNav";
import { normalizeDirPath, parentDirPath } from "@/utils/fileDragMove";

/** One pane's directory listing and navigation. */
export interface PaneListing {
  /** The directory shown (empty until the first listing resolved). */
  path: string;
  /** Its entries, folders first, by name. */
  entries: FileEntry[];
  loading: boolean;
  /** The last listing error, cleared by the next successful listing. */
  error: string | null;
  /** List `path` and show it. Resolves once the listing settled. */
  navigate: (path: string) => Promise<void>;
  /** Re-list the current directory. */
  refresh: () => Promise<void>;
  /** Go to the parent directory (no-op at a root). */
  up: () => Promise<void>;
}

/** True for `/` and a Windows drive root. */
export function isRootPath(path: string): boolean {
  const p = normalizeDirPath(path);
  return p === "/" || /^[A-Za-z]:\/?$/.test(p);
}

/**
 * Resolve a symbolic start directory (`~`) to the real one, using the listing:
 * every entry's parent is the listed directory.
 */
function resolveListedPath(requested: string, entries: FileEntry[]): string {
  if (requested !== "~" || entries.length === 0) return requested;
  return parentDirPath(entries[0].path);
}

/**
 * The listing of one transfer-view pane (PROD-007, #3558). The local pane
 * lists the local disk; the remote pane lists `sessionId` through the session
 * file browser and resets when the session changes. A slower, older listing
 * never overwrites a newer one.
 */
export function usePaneListing(
  side: PaneSide,
  sessionId: string | null,
  initialPath?: string
): PaneListing {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const pathRef = useRef("");

  const navigate = useCallback(
    async (target: string) => {
      if (side === "remote" && !sessionId) return;
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const listed =
          side === "local"
            ? await localListDir(target)
            : await sessionListFiles(sessionId as string, target);
        if (seq !== requestSeq.current) return;
        const resolved = resolveListedPath(target, listed);
        pathRef.current = resolved;
        setPath(resolved);
        setEntries(sortEntries(listed, "name", "asc"));
        setError(null);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(errorMessage(err));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [side, sessionId]
  );

  const refresh = useCallback(() => navigate(pathRef.current), [navigate]);

  const up = useCallback(async () => {
    const current = pathRef.current;
    if (!current || isRootPath(current)) return;
    await navigate(parentDirPath(current));
  }, [navigate]);

  // Initial listing, and a fresh start whenever the remote session changes.
  useEffect(() => {
    pathRef.current = "";
    setPath("");
    setEntries([]);
    setError(null);
    if (side === "remote") {
      if (sessionId) void navigate(initialPath ?? "~");
      return;
    }
    if (initialPath) {
      void navigate(initialPath);
      return;
    }
    getHomeDir()
      .then((home) => navigate(home))
      .catch(() => navigate("/"));
    // `initialPath` only seeds the first listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, sessionId, navigate]);

  return { path, entries, loading, error, navigate, refresh, up };
}
