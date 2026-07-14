import type { FileEntry } from "@/types/connection";

/** Column a file list can be sorted by. */
export type FileSortKey = "name" | "size" | "modified";

/** Sort direction applied within the directory/file groups. */
export type SortDirection = "asc" | "desc";

/** A single clickable segment of a breadcrumb path bar. */
export interface PathCrumb {
  /** Human-readable label shown in the crumb (e.g. `home`, `C:`, `/`). */
  label: string;
  /** Absolute path this crumb navigates to when clicked. */
  path: string;
}

/**
 * Split a filesystem path into cumulative breadcrumb segments.
 *
 * Handles POSIX paths (`/home/user`), Windows drive paths (`C:/Users`), and
 * WSL UNC paths (`//wsl$/Ubuntu/home`). Backslashes are normalized to forward
 * slashes first. Each returned crumb carries the absolute path it navigates to,
 * so the breadcrumb reuses the same navigate call as the folder rows.
 */
export function splitPathSegments(path: string): PathCrumb[] {
  if (!path) return [];
  const norm = path.replace(/\\/g, "/");

  let rootPath: string;
  let rootLabel: string;
  let remainder: string;

  const uncMatch = norm.match(/^\/\/([^/]+)\/([^/]+)(\/.*)?$/);
  const driveMatch = norm.match(/^([A-Za-z]:)(\/.*)?$/);

  if (uncMatch) {
    const [, host, share, rest] = uncMatch;
    rootPath = `//${host}/${share}`;
    rootLabel = rootPath;
    remainder = rest ?? "";
  } else if (driveMatch) {
    const [, drive, rest] = driveMatch;
    rootPath = `${drive}/`;
    rootLabel = drive;
    remainder = rest ?? "";
  } else if (norm.startsWith("/")) {
    rootPath = "/";
    rootLabel = "/";
    remainder = norm;
  } else {
    // Relative or shell-relative (e.g. "~") — treat the whole thing as one crumb.
    return [{ label: norm, path: norm }];
  }

  const crumbs: PathCrumb[] = [{ label: rootLabel, path: rootPath }];
  let acc = rootPath === "/" ? "" : rootPath.replace(/\/$/, "");
  for (const seg of remainder.split("/").filter(Boolean)) {
    acc = `${acc}/${seg}`;
    crumbs.push({ label: seg, path: acc });
  }
  return crumbs;
}

/**
 * Sort file entries for display. Directories are always grouped before files
 * (regardless of direction); the chosen key and direction order entries within
 * each group, with a name tiebreaker for stable results.
 */
export function sortEntries(
  entries: FileEntry[],
  key: FileSortKey,
  direction: SortDirection
): FileEntry[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let cmp = 0;
    if (key === "size") {
      cmp = a.size - b.size;
    } else if (key === "modified") {
      cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
    } else {
      cmp = a.name.localeCompare(b.name);
    }
    if (cmp === 0) cmp = a.name.localeCompare(b.name);
    return cmp * factor;
  });
}

/** Filter entries to those whose name contains `query` (case-insensitive). */
export function filterEntries(entries: FileEntry[], query: string): FileEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

/**
 * Find the index of the next entry whose label starts with `buffer`
 * (case-insensitive), searching circularly from `currentIndex`.
 *
 * Generic over the entry type: `getLabel` extracts the string to match against
 * (a file's name, a tree node's label, …), so the same type-ahead logic drives
 * any list view.
 *
 * When `advance` is true the search starts just after `currentIndex` (used for
 * repeated single-key presses that step through matches); when false it starts
 * at `currentIndex` (used while a multi-key type-ahead buffer is still growing).
 * Returns -1 when the buffer is empty or nothing matches.
 */
export function findTypeAheadIndex<T>(
  entries: T[],
  getLabel: (entry: T) => string,
  buffer: string,
  currentIndex: number,
  advance: boolean
): number {
  if (!buffer || entries.length === 0) return -1;
  const needle = buffer.toLowerCase();
  const n = entries.length;
  // `currentIndex` (the roving active index) is always >= 0, so `start` is too.
  const start = advance ? currentIndex + 1 : currentIndex;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    if (getLabel(entries[idx]).toLowerCase().startsWith(needle)) return idx;
  }
  return -1;
}

/**
 * Parent directory of a POSIX-style path (`/a/b/c` → `/a/b`, `/a` → `/`).
 * A trailing slash is ignored. Returns `/` when there is no parent.
 */
function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

/**
 * Collapse `.` and `..` segments in a POSIX path, preserving a leading `/`.
 * `..` past the root is clamped at the root.
 */
function normalizePosixPath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else {
      out.push(seg);
    }
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

/**
 * Resolve the path a symlink entry should navigate to when followed.
 *
 * Absolute targets are used as-is (normalized); relative targets resolve
 * against the link's own parent directory. When the backend reported no target
 * (e.g. FTP MLSD `type=link`), the link's own path is returned so the server
 * resolves it on the listing request.
 */
export function resolveSymlinkTarget(entry: FileEntry): string {
  const target = entry.symlinkTarget;
  if (!target) return entry.path;
  const isAbsolute = target.startsWith("/") || /^[A-Za-z]:/.test(target);
  if (isAbsolute) return normalizePosixPath(target);
  return normalizePosixPath(`${parentDir(entry.path)}/${target}`);
}
