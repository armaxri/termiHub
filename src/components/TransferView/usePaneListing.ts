import { useCallback, useEffect, useRef, useState } from "react";
import { getHomeDir, localListDir, sessionListFiles } from "@/services/api";
import type { PaneSide } from "@/services/paneTransfer";
import type { FileEntry } from "@/types/connection";
import { errorMessage } from "@/utils/errorMessage";
import { sortEntries } from "@/utils/fileBrowserNav";
import { normalizeDirPath, parentDir } from "@/utils/paths";

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
  return parentDir(entries[0].path);
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
  // The directory last asked for, and its listing while in flight. Until a
  // listing resolves, `path` is empty: a refresh then joins the pending listing
  // (or, after it failed, re-requests its directory) instead of listing "" —
  // which superseded the first listing and stranded the pane (#4910).
  const requestedRef = useRef("");
  const inFlight = useRef<Promise<void> | null>(null);

  const navigate = useCallback(
    (target: string): Promise<void> => {
      if ((side === "remote" && !sessionId) || !target) return Promise.resolve();
      requestedRef.current = target;
      const seq = ++requestSeq.current;
      const isLatest = () => seq === requestSeq.current;
      setLoading(true);
      const listing = (async () => {
        try {
          const listed =
            side === "local"
              ? await localListDir(target)
              : await sessionListFiles(sessionId as string, target);
          if (!isLatest()) return;
          const resolved = resolveListedPath(target, listed);
          pathRef.current = resolved;
          setPath(resolved);
          setEntries(sortEntries(listed, "name", "asc"));
          setError(null);
        } catch (err) {
          if (isLatest()) setError(errorMessage(err));
        } finally {
          if (isLatest()) {
            setLoading(false);
            inFlight.current = null;
          }
        }
      })();
      inFlight.current = listing;
      return listing;
    },
    [side, sessionId]
  );

  const refresh = useCallback((): Promise<void> => {
    if (!pathRef.current && inFlight.current) return inFlight.current;
    return navigate(pathRef.current || requestedRef.current);
  }, [navigate]);

  const up = useCallback(async () => {
    const current = pathRef.current;
    if (!current || isRootPath(current)) return;
    await navigate(parentDir(current));
  }, [navigate]);

  // Initial listing, and a fresh start whenever the remote session changes.
  useEffect(() => {
    pathRef.current = "";
    requestedRef.current = "";
    inFlight.current = null;
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
