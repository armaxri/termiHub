#!/usr/bin/env node
// Regenerate tests/system/testid-catalog.md when a source file's `data-testid`
// set may have changed, so a stale catalog never reaches CI (#1084).
//
// Background: `scripts/build-testid-catalog.py` generates the catalog and the
// "Frontend Code Quality" CI job verifies its freshness (`--check`, #899). A
// stale catalog fails that job *and* the system-test machinery job, and used to
// require a manual `python scripts/build-testid-catalog.py` per branch — easy to
// forget, costing red CI runs (the whole of #1062 hit this repeatedly).
//
// This helper is invoked from the autoformat PostToolUse hook
// (`autoformat.sh`) for every edited `.ts`/`.tsx`. It self-gates: it only runs
// the (Python) generator when the edited file is an app source file that
// actually contains a `data-testid`. The catalog stays the single source of
// truth in Python; this is just the "when to regenerate" glue.
//
// The logic lives here (rather than inline in bash) so the two fragile parts —
// the trigger predicate and locating a usable Python interpreter across
// platforms (Windows ships a `python`/`python3` App-Execution-Alias stub that is
// NOT a real interpreter) — can be unit-tested. See regen-testid-catalog.test.mjs.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Filename suffixes that are tests/fixtures/decls, not app UI (mirrors the Python scanner). */
const SKIP_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts"];

/** Path segments whose contents are tests/mocks/plumbing, not app UI. */
const SKIP_DIR_PARTS = new Set(["__tests__", "test", "__mocks__", "testbridge"]);

/** Interpreter candidates tried in order; the first that probes as real Python 3 wins. */
export const PYTHON_CANDIDATES = [
  ["python3"],
  ["python"],
  ["py", "-3"],
  ["python3.12"],
  // Last resort: uv provisions a managed CPython. On a box with no system
  // Python (e.g. only the Windows Store alias), this makes the hook work; uv
  // caches the interpreter after the first use.
  ["uv", "run", "--python", "3.12", "python"],
];

/**
 * Decide whether editing `filePath` (with the given `contents`) should trigger a
 * catalog regeneration.
 *
 * True only for an app-source `.ts`/`.tsx` file under `src/` that is not a
 * test/spec/decl/mock and actually contains a `data-testid`.
 *
 * @param {string} filePath - Absolute or relative path to the edited file.
 * @param {string} contents - The file's text contents.
 * @returns {boolean}
 */
export function shouldRegenerate(filePath, contents) {
  if (typeof filePath !== "string" || typeof contents !== "string") {
    return false;
  }
  const norm = filePath.replace(/\\/g, "/");
  const match = norm.match(/(?:^|\/)src\/(.+\.(?:ts|tsx))$/);
  if (!match) {
    return false;
  }
  const relFromSrc = match[1];
  if (SKIP_SUFFIXES.some((suffix) => relFromSrc.endsWith(suffix))) {
    return false;
  }
  const dirParts = relFromSrc.split("/").slice(0, -1);
  if (dirParts.some((part) => SKIP_DIR_PARTS.has(part))) {
    return false;
  }
  return contents.includes("data-testid");
}

/**
 * Resolve a usable Python 3 interpreter from `candidates`, using `probe` to test
 * each. Returns the first candidate argv that probes successfully, or null.
 *
 * @param {string[][]} [candidates] - Ordered interpreter argv candidates.
 * @param {(argv: string[]) => boolean} [probe] - Returns true if argv is real Python 3.
 * @returns {string[] | null}
 */
export function resolvePython(candidates = PYTHON_CANDIDATES, probe = probePython) {
  for (const argv of candidates) {
    if (probe(argv)) {
      return argv;
    }
  }
  return null;
}

/**
 * Probe whether `argv` launches a real Python 3 interpreter.
 *
 * Runs `argv --version` and requires a clean exit that reports "Python 3.x".
 * This rejects the Windows App-Execution-Alias stub (`python`/`python3` with no
 * real install), which prints "Python was not found…" and exits non-zero.
 *
 * Runs via the shell (a single command string, not an args array) so bare
 * commands (`uv`, `python`, `py`) resolve via `PATHEXT` on Windows — Node does
 * not do that resolution itself. `--version` is a single, space-free argument,
 * so it needs no quoting. The candidate parts come from a fixed internal list,
 * so there is no untrusted input in the command string.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function probePython(argv) {
  try {
    const result = spawnSync(`${argv.join(" ")} --version`, {
      encoding: "utf8",
      timeout: 20000,
      shell: true,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return result.status === 0 && /Python 3\./.test(output);
  } catch {
    return false;
  }
}

/**
 * Run the Python catalog generator with the resolved interpreter.
 *
 * Uses the shell for the same cross-platform command resolution as
 * {@link probePython}; the script path is quoted so a path containing spaces
 * survives the shell.
 *
 * @param {string[]} pythonArgv - Interpreter argv from {@link resolvePython}.
 * @param {string} scriptPath - Path to build-testid-catalog.py.
 * @returns {boolean} True if the generator ran and exited 0.
 */
export function runGenerator(pythonArgv, scriptPath) {
  const result = spawnSync(`${pythonArgv.join(" ")} "${scriptPath}"`, {
    encoding: "utf8",
    timeout: 25000,
    shell: true,
  });
  return result.status === 0;
}

// CLI mode: `node regen-testid-catalog.mjs <edited-file>`. Best-effort and
// quiet — any failure (no Python, unreadable file) is swallowed so the hook
// never blocks an edit; CI's freshness check remains the correctness backstop.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const filePath = process.argv[2];
  if (filePath) {
    try {
      const contents = readFileSync(filePath, "utf8");
      if (shouldRegenerate(filePath, contents)) {
        const python = resolvePython();
        if (python) {
          const scriptPath = resolve(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "build-testid-catalog.py"
          );
          runGenerator(python, scriptPath);
        }
      }
    } catch {
      // Best-effort: never fail the edit.
    }
  }
}
