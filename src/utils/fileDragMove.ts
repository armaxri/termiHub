import type { FileEntry } from "@/types/connection";
import type { FileClipboard } from "@/store/appStore";
import { normalizeDirPath, parentDir } from "@/utils/paths";
import { errorMessage } from "@/utils/errorMessage";

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
  const effective = entries.filter((e) => normalizeDirPath(parentDir(e.path)) !== dest);
  if (effective.length === 0) return { kind: "noop" };
  return { kind: "ok", entries: effective };
}

/** Entries whose name already exists among `existingNames` in the destination. */
export function findNameConflicts(entries: FileEntry[], existingNames: Iterable<string>): string[] {
  const existing = new Set(existingNames);
  return entries.filter((e) => existing.has(e.name)).map((e) => e.name);
}

/**
 * How a rename or New File treats an existing entry of the target name
 * (#5157): `overwrite` only once the user confirmed replacing it; otherwise
 * the transport refuses to clobber where it can.
 */
export interface WriteTargetOptions {
  overwrite?: boolean;
}

/** Where an upload lands: `destName` overrides the source's basename ("Keep Both"). */
export interface UploadTargetOptions {
  destName?: string;
}

/**
 * A free name for a "Keep both" upload (#5157): `report.txt` becomes
 * `report (1).txt`, then `report (2).txt`, … — the first not in
 * `existingNames`. A folder, a dotfile (`.bashrc`) or an extension-less name
 * gets the suffix at the end (`docs (1)`, `.bashrc (1)`).
 */
export function keepBothName(
  name: string,
  existingNames: Iterable<string>,
  isDirectory = false
): string {
  const existing = new Set(existingNames);
  const dot = isDirectory ? -1 : name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/**
 * Whether a backend error says the target already exists — the refusal of a
 * no-clobber rename / exclusive create (#5157) that lost a race against
 * another writer after the exists-check.
 */
export function isAlreadyExistsError(err: unknown): boolean {
  return /already exists|file exists|EEXIST/i.test(errorMessage(err));
}

/** Human summary of the entries for toasts/dialogs ("a.txt" or "3 items"). */
export function describeEntries(entries: FileEntry[]): string {
  return entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`;
}

/**
 * Optional overrides for a browser's `pasteEntry`, letting drag-to-move and the
 * "Move to… / Copy to…" dialog reuse the paste plumbing without touching the
 * user's copy/cut clipboard: `clipboard` replaces the stored clipboard for this
 * one call (and is never cleared afterwards), `destDir` replaces the current
 * folder as the destination, and `verb` words the progress toasts.
 */
export interface PasteOptions {
  clipboard?: FileClipboard;
  destDir?: string;
  verb?: "Paste" | "Move" | "Copy";
}

/** Progress/success toast wording for a paste-like action. */
export function pasteVerbLabels(verb: PasteOptions["verb"] = "Paste"): {
  loading: string;
  done: string;
} {
  switch (verb) {
    case "Move":
      return { loading: "Moving", done: "Moved" };
    case "Copy":
      return { loading: "Copying", done: "Copied" };
    default:
      return { loading: "Pasting", done: "Pasted" };
  }
}
