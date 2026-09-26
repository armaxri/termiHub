import type { FileEntry } from "@/types/connection";
import type { DragOutStagingEntry } from "@/services/api";

/**
 * Pure planning helpers for dragging file-browser rows out of the window onto
 * the OS file manager (#3457, #3491). No I/O lives here (the remote lister is
 * injected): {@link useFileDragOut} stages remote entries and starts the native
 * drag.
 *
 * - A **local** row already has a real path, so the native drag starts at once.
 * - A **transfer-queue** session row (SFTP / FTP) — file or folder — is first
 *   downloaded into a private staging directory through the transfer queue
 *   (folders are walked recursively, within {@link DRAG_OUT_LIMITS});
 * - a **byte-based** session row (Docker / remote agent) is staged by the
 *   backend, which reads it through the session into a directory it owns.
 *
 * When staging finishes while the pointer is still held outside the window the
 * native drag starts, otherwise the staged copy is kept for
 * {@link STAGED_DRAG_OUT_TTL_MS} so the next drag-out of the same (unchanged)
 * entries is instant.
 */

/** How long a staged remote copy stays reusable before it is discarded. */
export const STAGED_DRAG_OUT_TTL_MS = 10 * 60 * 1000;

/**
 * Bounds for staging a remote folder through the transfer queue. Entry count
 * and depth mirror the backend's `MAX_STAGED_ENTRIES` / `MAX_STAGED_DEPTH`;
 * the byte cap keeps a drag-out from silently filling the disk — anything
 * bigger belongs in Download.
 */
export const DRAG_OUT_LIMITS = {
  maxEntries: 10_000,
  maxDepth: 32,
  maxBytes: 4 * 1024 * 1024 * 1024,
} as const;

/** The file-browser pane a drag-out starts from. */
export type DragOutSource =
  | { mode: "local" }
  | { mode: "session"; sessionId: string | null; transferQueueCapable: boolean }
  | { mode: "none" };

/** Outcome of {@link planDragOut}. */
export type DragOutPlan =
  | { kind: "local"; paths: string[] }
  | { kind: "remote"; sessionId: string; entries: FileEntry[] }
  | { kind: "sessionBytes"; sessionId: string; entries: FileEntry[] }
  | { kind: "refuse"; message: string };

/**
 * Decide how `entries` can leave the window: local paths go straight to the OS
 * drag; transfer-queue session rows (files and folders) are staged through the
 * queue; byte-based session rows (Docker / agent) are staged by the backend.
 */
export function planDragOut(entries: FileEntry[], source: DragOutSource): DragOutPlan {
  if (entries.length === 0) return { kind: "refuse", message: "Nothing to drag" };
  if (source.mode === "local") return { kind: "local", paths: entries.map((e) => e.path) };
  if (source.mode === "none" || !source.sessionId) {
    return { kind: "refuse", message: "No file browser is connected" };
  }
  if (!source.transferQueueCapable) {
    return { kind: "sessionBytes", sessionId: source.sessionId, entries };
  }
  return { kind: "remote", sessionId: source.sessionId, entries };
}

/** A remote selection too large to stage for a drag-out. */
export class DragOutLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DragOutLimitError";
  }
}

/** A remote selection laid out for staging through the transfer queue. */
export interface DragOutStagingTree {
  /** Every entry to lay out, parents before children (for `dragOutCreateStaging`). */
  staging: DragOutStagingEntry[];
  /** The files to download: the remote path and its index in {@link staging}. */
  downloads: { index: number; remotePath: string }[];
  /** Index in {@link staging} of each dragged row, in selection order. */
  roots: number[];
}

/**
 * Walk a remote selection into a staging tree: dragged files become top-level
 * entries, dragged folders are listed recursively with `list`. Symlinked folders
 * are not followed and `.` / `..` listing rows are skipped. Throws a
 * {@link DragOutLimitError} once the selection exceeds `limits` (entries, depth
 * or total file bytes), before anything is downloaded.
 */
export async function buildStagingTree(
  entries: FileEntry[],
  list: (path: string) => Promise<FileEntry[]>,
  limits: { maxEntries: number; maxDepth: number; maxBytes: number } = DRAG_OUT_LIMITS
): Promise<DragOutStagingTree> {
  const tree: DragOutStagingTree = { staging: [], downloads: [], roots: [] };
  let bytes = 0;
  const add = (entry: FileEntry, segments: string[]): void => {
    if (tree.staging.length >= limits.maxEntries) {
      throw new DragOutLimitError(
        `The selection has more than ${limits.maxEntries} entries — use Download instead`
      );
    }
    if (segments.length - 1 > limits.maxDepth) {
      throw new DragOutLimitError(
        `The selection is nested deeper than ${limits.maxDepth} levels — use Download instead`
      );
    }
    tree.staging.push({ segments, isDirectory: entry.isDirectory });
    if (entry.isDirectory) return;
    bytes += entry.size;
    if (bytes > limits.maxBytes) {
      throw new DragOutLimitError(
        `The selection is larger than ${Math.round(limits.maxBytes / (1024 * 1024))} MiB — use Download instead`
      );
    }
    tree.downloads.push({ index: tree.staging.length - 1, remotePath: entry.path });
  };
  const walk = async (entry: FileEntry, segments: string[]): Promise<void> => {
    add(entry, segments);
    if (!entry.isDirectory) return;
    for (const child of await list(entry.path)) {
      if (child.name === "." || child.name === "..") continue;
      if (child.isDirectory && child.isSymlink) continue;
      await walk(child, [...segments, child.name]);
    }
  };
  for (const entry of entries) {
    tree.roots.push(tree.staging.length);
    await walk(entry, [entry.name]);
  }
  return tree;
}

/**
 * Run `task` over `items` with at most `limit` in flight. After the first
 * failure no new task starts; every started task is still allowed to settle
 * (so a failed staging dir is never discarded under a sibling still writing
 * into it), then the first failure is rethrown.
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<unknown>
): Promise<void> {
  let next = 0;
  // Declared via `as` so TS does not narrow it to `null` (workers assign it).
  let failure = null as { error: unknown } | null;
  const worker = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await task(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure) throw failure.error;
}

/**
 * Whether a pointer at client coordinates (`x`, `y`) lies outside a
 * `width` × `height` viewport — the trigger that turns an in-app drag into a
 * drag-out.
 */
export function isOutsideViewport(x: number, y: number, width: number, height: number): boolean {
  return x < 0 || y < 0 || x >= width || y >= height;
}

/** One staged remote drag-out: the private directory and its local copies. */
export interface StagedDragOut {
  dir: string;
  /** Local copy per staged entry, keyed by {@link stagedEntryKey}. */
  paths: Map<string, string>;
  expiresAt: number;
}

/**
 * Cache identity of a remote entry: the session, its path, and its size and
 * mtime — so an entry that changed on the server is downloaded again.
 */
export function stagedEntryKey(sessionId: string, entry: FileEntry): string {
  return [sessionId, entry.path, entry.size, entry.modified].join("\u0000");
}

/**
 * Remote drag-out copies that can be reused while fresh. A lookup succeeds only
 * when every requested entry is staged and unexpired, so a partially staged
 * selection is staged again as a whole.
 */
export class StagedDragOutCache {
  private readonly staged: StagedDragOut[] = [];

  /** Record a staged set of entries. */
  add(sessionId: string, entries: FileEntry[], dir: string, paths: string[], now: number): void {
    const map = new Map<string, string>();
    entries.forEach((entry, i) => map.set(stagedEntryKey(sessionId, entry), paths[i]));
    this.staged.push({ dir, paths: map, expiresAt: now + STAGED_DRAG_OUT_TTL_MS });
  }

  /** Local copies of `entries` when all are staged and fresh, else `null`. */
  lookup(sessionId: string, entries: FileEntry[], now: number): string[] | null {
    const out: string[] = [];
    for (const entry of entries) {
      const key = stagedEntryKey(sessionId, entry);
      const hit = this.staged.find((s) => s.expiresAt > now && s.paths.has(key));
      const path = hit?.paths.get(key);
      if (!path) return null;
      out.push(path);
    }
    return out;
  }

  /** Remove and return the directories whose reuse window has lapsed. */
  takeExpired(now: number): string[] {
    const expired = this.staged.filter((s) => s.expiresAt <= now);
    for (const s of expired) this.staged.splice(this.staged.indexOf(s), 1);
    return expired.map((s) => s.dir);
  }

  /** Remove and return every staged directory. */
  takeAll(): string[] {
    return this.staged.splice(0, this.staged.length).map((s) => s.dir);
  }

  /** Number of staged sets (for tests). */
  get size(): number {
    return this.staged.length;
  }
}

/** App-wide cache of staged remote drag-out copies. */
export const stagedDragOutCache = new StagedDragOutCache();

/** After a native drag-out ends, how long an OS drop of its paths is still ignored. */
export const SELF_DROP_GRACE_MS = 1000;

let activeDragOut: { paths: Set<string>; until: number } | null = null;

/** Separator-insensitive path identity (the OS may report backslashes where we sent `/`). */
function pathKey(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Mark `paths` as leaving the window in a native drag-out (until {@link endDragOut}). */
export function beginDragOut(paths: string[]): void {
  activeDragOut = { paths: new Set(paths.map(pathKey)), until: Number.POSITIVE_INFINITY };
}

/** The native drag-out ended; keep ignoring its own drop for a short grace period. */
export function endDragOut(now: number = Date.now()): void {
  if (activeDragOut) activeDragOut.until = now + SELF_DROP_GRACE_MS;
}

/**
 * Whether an OS drop of `paths` is this window's own drag-out coming back — a
 * row dragged out and released over termiHub itself must not re-upload / copy
 * the file into the browser it came from.
 */
export function isOwnDragOut(paths: string[], now: number = Date.now()): boolean {
  if (!activeDragOut || now > activeDragOut.until || paths.length === 0) return false;
  const own = activeDragOut.paths;
  return paths.every((p) => own.has(pathKey(p)));
}

/** Reset the drag-out tracking (tests only). */
export function resetDragOutTracking(): void {
  activeDragOut = null;
}
