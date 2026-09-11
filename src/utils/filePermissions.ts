/**
 * Helpers for converting between the three representations of a Unix file mode
 * used by the file browser's permissions editor:
 *
 * - the 9-char `rwxrwxrwx` string the backend returns on a {@link FileEntry}
 *   (`FileEntry.permissions`),
 * - the numeric mode (the low 12 bits — the nine permission bits plus the
 *   setuid/setgid/sticky bits) the backend's chmod command expects, and
 * - the 3- or 4-digit octal string shown in and typed into the editor.
 *
 * The editor pre-fills from the row's `rwx` string (special bits are not encoded
 * in that string, so they read as `0`), lets the user edit either the checkbox
 * grid or the octal input, and applies the resulting numeric mode.
 */

/** One permission class (owner / group / other) as three booleans. */
export interface PermissionClass {
  read: boolean;
  write: boolean;
  execute: boolean;
}

/** A full permission set across the three classes. */
export interface PermissionTriple {
  owner: PermissionClass;
  group: PermissionClass;
  other: PermissionClass;
}

/**
 * Parse a 9-char `rwxrwxrwx` permission string (as produced by the backend) into
 * its numeric mode. A leading file-type char (e.g. the `d` of `drwxr-xr-x`) is
 * tolerated and ignored. Returns `null` when the string is too short or has an
 * unexpected shape, so the caller can fall back to `0`.
 *
 * Only the nine permission bits are represented in the string, so setuid/setgid/
 * sticky are always `0` in the result.
 */
export function parsePermissionString(perms: string): number | null {
  // Drop a leading type char if the string is 10 chars (e.g. "drwxr-xr-x").
  const body = perms.length === 10 ? perms.slice(1) : perms;
  if (body.length !== 9) return null;

  let mode = 0;
  // [bit value, expected char at that index]
  const table: Array<[number, string, number]> = [
    [0o400, "r", 0],
    [0o200, "w", 1],
    [0o100, "x", 2],
    [0o040, "r", 3],
    [0o020, "w", 4],
    [0o010, "x", 5],
    [0o004, "r", 6],
    [0o002, "w", 7],
    [0o001, "x", 8],
  ];
  for (const [value, expected, index] of table) {
    const ch = body[index];
    if (ch === expected) {
      mode |= value;
    } else if (ch !== "-") {
      // Anything other than the expected letter or a dash is unexpected. Special
      // exec markers (s/S/t/T) are treated as an execute bit set for editing.
      if (index === 2 || index === 5 || index === 8) {
        if (ch === "s" || ch === "t") mode |= value;
      } else {
        return null;
      }
    }
  }
  return mode;
}

/** Format a numeric mode as its 9-char `rwxrwxrwx` string (permission bits only). */
export function formatPermissionString(mode: number): string {
  const bits: Array<[number, string]> = [
    [0o400, "r"],
    [0o200, "w"],
    [0o100, "x"],
    [0o040, "r"],
    [0o020, "w"],
    [0o010, "x"],
    [0o004, "r"],
    [0o002, "w"],
    [0o001, "x"],
  ];
  return bits.map(([value, ch]) => (mode & value ? ch : "-")).join("");
}

/** Render a numeric mode as a 3-digit octal string (low 9 bits, e.g. `"755"`). */
export function modeToOctalString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Parse a 3- or 4-digit octal string (e.g. `"755"` or `"0644"`) into a numeric
 * mode. Returns `null` for anything that is not a valid octal permission string
 * so the input can show an inline error rather than applying a bad mode.
 */
export function parseOctalString(input: string): number | null {
  const trimmed = input.trim();
  if (!/^[0-7]{3,4}$/.test(trimmed)) return null;
  return parseInt(trimmed, 8);
}

/** Decompose a numeric mode into the owner/group/other checkbox grid. */
export function modeToTriple(mode: number): PermissionTriple {
  const cls = (r: number, w: number, x: number): PermissionClass => ({
    read: (mode & r) !== 0,
    write: (mode & w) !== 0,
    execute: (mode & x) !== 0,
  });
  return {
    owner: cls(0o400, 0o200, 0o100),
    group: cls(0o040, 0o020, 0o010),
    other: cls(0o004, 0o002, 0o001),
  };
}

/** Recompose a numeric mode (low 9 bits) from the checkbox grid. */
export function tripleToMode(triple: PermissionTriple): number {
  const cls = (c: PermissionClass, r: number, w: number, x: number): number =>
    (c.read ? r : 0) | (c.write ? w : 0) | (c.execute ? x : 0);
  return (
    cls(triple.owner, 0o400, 0o200, 0o100) |
    cls(triple.group, 0o040, 0o020, 0o010) |
    cls(triple.other, 0o004, 0o002, 0o001)
  );
}
