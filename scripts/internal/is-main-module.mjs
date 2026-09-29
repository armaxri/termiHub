/**
 * Shared "am I the entry point?" check for the Node scripts under scripts/.
 *
 * The old idiom, ``import.meta.url === `file://${process.argv[1]}` ``, never
 * matches on Windows: argv[1] is "D:\\...\\x.mjs" while import.meta.url is
 * "file:///D:/.../x.mjs". The script then silently exits 0 without doing
 * anything, which made release-check.cmd report green lanes on a commit with no
 * CI runs (#3753, #3840). Comparing raw `fileURLToPath(import.meta.url)` with an
 * unresolved argv[1] has the same problem for relative invocations
 * (`node scripts/internal/x.mjs`).
 *
 * This compares resolved filesystem paths instead: case-insensitively on
 * Windows (drive letters and NTFS names are case-insensitive), and with a
 * realpath fallback so a symlinked checkout (macOS /var -> /private/var) still
 * matches.
 *
 * Usage:
 *   import { isMainModule } from "./is-main-module.mjs";
 *   if (isMainModule(import.meta.url)) { ... CLI mode ... }
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} metaUrl the calling module's `import.meta.url`
 * @param {object} [options] injection points for tests
 * @param {string | undefined} [options.argv1] the entry script path (default: process.argv[1])
 * @param {string} [options.platform] "win32" selects Windows path semantics (default: process.platform)
 * @param {(p: string) => string} [options.realpath] symlink resolver (default: fs.realpathSync.native)
 * @returns {boolean} true when the module at `metaUrl` is the script node was started with
 */
export function isMainModule(metaUrl, options = {}) {
  const argv1 = "argv1" in options ? options.argv1 : process.argv[1];
  const platform = options.platform ?? process.platform;
  const realpath = options.realpath ?? realpathSync.native;
  if (!argv1 || !metaUrl) return false;

  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  let modulePath;
  try {
    modulePath = fileURLToPath(metaUrl, { windows });
  } catch {
    // Not a file: URL (e.g. data: or a bundler-provided URL): never the entry.
    return false;
  }

  const norm = (x) => {
    const resolved = p.resolve(x);
    return windows ? resolved.toLowerCase() : resolved;
  };
  if (norm(argv1) === norm(modulePath)) return true;

  try {
    return norm(realpath(argv1)) === norm(realpath(modulePath));
  } catch {
    return false;
  }
}
