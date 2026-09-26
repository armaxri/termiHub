import type { FileEntry } from "@/types/connection";

/**
 * Pure planning helpers for dragging file-browser rows out of the window onto
 * the OS file manager (#3457). No I/O lives here: {@link useFileDragOut} stages
 * remote entries through the transfer queue and starts the native drag.
 *
 * - A **local** row already has a real path, so the native drag starts at once.
 * - A **session** row (SFTP / FTP) is first downloaded into a private staging
 *   directory; when that finishes while the pointer is still held outside the
 *   window the native drag starts, otherwise the staged copy is kept for
 *   {@link STAGED_DRAG_OUT_TTL_MS} so the next drag-out of the same (unchanged)
 *   entries is instant.
 */

/** How long a staged remote copy stays reusable before it is discarded. */
export const STAGED_DRAG_OUT_TTL_MS = 10 * 60 * 1000;

/** The file-browser pane a drag-out starts from. */
export type DragOutSource =
  | { mode: "local" }
  | { mode: "session"; sessionId: string | null; transferQueueCapable: boolean }
  | { mode: "none" };

/** Outcome of {@link planDragOut}. */
export type DragOutPlan =
  | { kind: "local"; paths: string[] }
  | { kind: "remote"; sessionId: string; entries: FileEntry[] }
  | { kind: "refuse"; message: string };

/**
 * Decide how `entries` can leave the window: local paths go straight to the OS
 * drag; session files must be staged first. Remote folders (no recursive
 * staging yet) and byte-based sessions (Docker / agent — no transfer queue to
 * stage through) are refused with a hint to use Download instead.
 */
export function planDragOut(entries: FileEntry[], source: DragOutSource): DragOutPlan {
  if (entries.length === 0) return { kind: "refuse", message: "Nothing to drag" };
  if (source.mode === "local") return { kind: "local", paths: entries.map((e) => e.path) };
  if (source.mode === "none" || !source.sessionId) {
    return { kind: "refuse", message: "No file browser is connected" };
  }
  if (!source.transferQueueCapable) {
    return {
      kind: "refuse",
      message: "Dragging out needs an SFTP or FTP session — use Download instead",
    };
  }
  const folder = entries.find((e) => e.isDirectory);
  if (folder) {
    return {
      kind: "refuse",
      message: `Folders can't be dragged out of a remote session yet — download "${folder.name}" instead`,
    };
  }
  return { kind: "remote", sessionId: source.sessionId, entries };
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
