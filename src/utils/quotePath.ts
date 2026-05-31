/**
 * Shell-safe quoting for a file path dropped onto a terminal.
 *
 * Windows-style paths (drive letter or backslash) are wrapped in double quotes;
 * everything else is wrapped in POSIX single quotes with embedded quotes escaped.
 */
export function quotePath(path: string): string {
  if (/^[A-Za-z]:/.test(path) || path.includes("\\")) {
    return `"${path.replace(/"/g, '\\"')}"`;
  }
  return `'${path.replace(/'/g, "'\\''")}'`;
}
