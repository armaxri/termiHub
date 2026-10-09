/**
 * Shared, synchronous path helpers for both local (possibly native Windows) and
 * remote (POSIX) paths (#4372).
 *
 * Every helper accepts either separator and treats the three root shapes as
 * fixed points: the POSIX root `/`, a Windows drive root `C:/` (`C:\`), and a UNC
 * share root `//server/share` (`\\server\share`). Results always use `/`, which
 * both the Rust backend's `std::path` on Windows and every remote backend accept.
 *
 * Deliberately not `@tauri-apps/api/path`: that is async, applies the local OS's
 * rules, and cannot handle remote POSIX paths shown in a Windows client.
 */

/** Matches a UNC share root (`//server/share`), after separator normalization. */
const UNC_ROOT = /^\/\/[^/]+\/[^/]+$/;

/** Matches a Windows drive root (`C:/`), after separator normalization. */
const DRIVE_ROOT = /^[A-Za-z]:\/$/;

/** True when the (already `/`-normalized) path is a root that has no parent. */
function isRoot(slashed: string): boolean {
  return slashed === "/" || DRIVE_ROOT.test(slashed) || UNC_ROOT.test(slashed);
}

/**
 * Normalize separators to `/` and drop trailing separators, except on a root
 * (`/`, `C:/`, `//server/share`). A bare drive (`C:`) becomes its root (`C:/`),
 * since on Windows a bare `C:` means the drive's current directory.
 */
export function normalizeDirPath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/*$/.test(slashed)) return `${slashed.slice(0, 2)}/`;
  if (/^\/+$/.test(slashed)) return "/";
  return slashed.replace(/\/+$/, "");
}

/**
 * The final segment (file or folder name) of a POSIX or Windows path. Trailing
 * separators are ignored (`/a/b/` → `b`). A root, or an empty path, is returned
 * unchanged because it has no name segment.
 */
export function getBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = trimmed.slice(idx + 1);
  if (!name || /^[A-Za-z]:$/.test(name)) return path;
  // `\\server\share` (a UNC share root) has no name segment either.
  if (UNC_ROOT.test(trimmed.replace(/\\/g, "/"))) return path;
  return name;
}

/**
 * The parent directory of a path. A top-level entry's parent is its root: `/a`
 * → `/`, `C:\a.txt` → `C:/`, `//srv/share/a` → `//srv/share`. A root is its own
 * parent, and a bare name with no separator resolves to `/`.
 */
export function parentDir(path: string): string {
  const normalized = normalizeDirPath(path);
  if (isRoot(normalized)) return normalized;
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return "/";
  const parent = normalized.slice(0, idx);
  if (parent === "") return "/";
  // Keep a Windows drive root as "C:/" rather than a bare "C:".
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}/`;
  return parent;
}

/** Join a directory and an entry name with a single `/` (an empty dir is `/`). */
export function joinPath(dir: string, name: string): string {
  const base = normalizeDirPath(dir);
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}
