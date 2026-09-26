import type { FileEntry } from "@/types/connection";

/**
 * Pure planning helpers for moving/copying file-browser entries into another
 * folder of the same filesystem — the drag-to-move gesture and the keyboard
 * "Move to… / Copy to…" dialog (audit PROD-006). No I/O lives here: the caller
 * lists the destination for conflicts and executes the transfer through the
 * existing paste plumbing.
 */

/** Whether the entries are moved (renamed, no data copy) or copied. */
export type FileTransferOperation = "move" | "copy";

/** Why a move/copy request was refused before touching the filesystem. */
export type FileDropRefusal = "into-self" | "read-only" | "empty";

/** Outcome of {@link planFileDrop}. */
export type FileDropPlan =
  | { kind: "refuse"; reason: FileDropRefusal; message: string }
  | { kind: "noop" }
  | { kind: "ok"; entries: FileEntry[] };

/** Normalise separators and drop a trailing slash (except on a root). */
export function normalizeDirPath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  if (slashed === "/" || /^[A-Za-z]:\/$/.test(slashed)) return slashed;
  return slashed.endsWith("/") ? slashed.slice(0, -1) : slashed;
}

/** Join a directory and an entry name with a single `/`. */
export function joinDirPath(dir: string, name: string): string {
  const base = normalizeDirPath(dir);
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

/** The parent directory of an absolute path (`/` for a top-level entry). */
export function parentDirPath(path: string): string {
  const normalized = normalizeDirPath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  const parent = normalized.slice(0, idx);
  // Keep a Windows drive root as "C:/" rather than a bare "C:".
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

/** True when `dir` is `entryPath` itself or lies somewhere beneath it. */
export function isSameOrDescendant(entryPath: string, dir: string): boolean {
  const src = normalizeDirPath(entryPath);
  const dest = normalizeDirPath(dir);
  if (dest === src) return true;
  const prefix = src.endsWith("/") ? src : `${src}/`;
  return dest.startsWith(prefix);
}

/**
 * Decide whether `entries` may be moved/copied into `destDir`.
 *
 * - A folder can never go into itself or one of its own descendants.
 * - A destination folder reported read-only (`writable === false`) is refused;
 *   `null` (unknown) is allowed and left to the backend.
 * - An entry dropped into the folder it already lives in is skipped — a move
 *   there is meaningless, and a copy onto itself would clobber the source — so
 *   if nothing is left the whole request is a no-op.
 */
export function planFileDrop(
  entries: FileEntry[],
  destDir: string,
  operation: FileTransferOperation,
  destEntry?: FileEntry | null
): FileDropPlan {
  if (entries.length === 0) {
    return { kind: "refuse", reason: "empty", message: "Nothing to move" };
  }
  const intoSelf = entries.find((e) => e.isDirectory && isSameOrDescendant(e.path, destDir));
  if (intoSelf) {
    return {
      kind: "refuse",
      reason: "into-self",
      message: `Cannot ${operation} "${intoSelf.name}" into itself`,
    };
  }
  if (destEntry && destEntry.writable === false) {
    return {
      kind: "refuse",
      reason: "read-only",
      message: `"${destEntry.name}" is read-only`,
    };
  }
  const dest = normalizeDirPath(destDir);
  const effective = entries.filter((e) => normalizeDirPath(parentDirPath(e.path)) !== dest);
  if (effective.length === 0) return { kind: "noop" };
  return { kind: "ok", entries: effective };
}

/** Entries whose name already exists among `existingNames` in the destination. */
export function findNameConflicts(entries: FileEntry[], existingNames: Iterable<string>): string[] {
  const existing = new Set(existingNames);
  return entries.filter((e) => existing.has(e.name)).map((e) => e.name);
}

/** Human summary of the entries for toasts/dialogs ("a.txt" or "3 items"). */
export function describeEntries(entries: FileEntry[]): string {
  return entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`;
}
