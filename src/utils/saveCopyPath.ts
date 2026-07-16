import { getBasename } from "@/utils/formatters";

/**
 * Suggest a likely-writable default destination for the SFTP "Save a copy…"
 * dialog (#1535).
 *
 * The dialog opens on a read-only remote file, so pre-filling the original path
 * only guarantees another failed save. Instead we aim at a path the user can
 * typically write without editing:
 *
 * 1. If the connecting user's remote home directory is known, drop the file's
 *    basename there (`<home>/<name>`) — home is almost always writable.
 * 2. Otherwise (home unresolved, or home would reproduce the original path),
 *    fall back to a same-directory sibling `<originalPath>.copy`, which at least
 *    never re-suggests the exact read-only path the save just failed on.
 *
 * Remote paths are POSIX, so joining uses `/`.
 *
 * @param originalPath the read-only remote path the editor is showing.
 * @param remoteHome the connecting user's resolved home directory, if known.
 * @returns a destination path to pre-fill; always editable by the user.
 */
export function suggestedSaveCopyPath(originalPath: string, remoteHome?: string | null): string {
  const home = remoteHome?.trim();
  if (home) {
    const base = getBasename(originalPath);
    const homePath = `${home.replace(/\/+$/, "")}/${base}`;
    // Guard against the file already living in home: home-join would reproduce
    // the read-only original, so keep the sibling fallback instead.
    if (homePath !== originalPath) return homePath;
  }
  return `${originalPath}.copy`;
}
