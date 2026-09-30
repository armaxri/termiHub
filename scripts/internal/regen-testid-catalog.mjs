#!/usr/bin/env node
// Refresh tests/system/testid-catalog.md when a source file's testid set may
// have changed, so the local reference stays current as you edit (#1084).
//
// Background: `scripts/build-testid-catalog.py` generates the catalog (#899).
// This helper does NOT generate one — it is the "when to regenerate" glue,
// invoked from the autoformat PostToolUse hook (`autoformat.sh`) for every
// edited `.ts`/`.tsx`, and it shells out to that same Python script. The
// generator is the single source of truth for catalog *content*; there is no
// second implementation to disagree with it (#1526).
//
// The catalog is a local, git-ignored artifact: it is not committed and CI
// regenerates it from source rather than diffing a checked-in copy (#1528). So
// a missed refresh no longer reddens CI — it just leaves a stale reference for
// whoever reads the catalog next.
//
// What this file *does* duplicate is the generator's notion of which files may
// carry a testid (SKIP_* and TESTID_TRIGGER below). The attribute list drifted
// twice — when #1431 added the forwarding props and when #3044 generalised the
// scanner to every `*TestId` sink — so the trigger is now the generator's own
// coarse `_TRIGGER` pattern, which every sink form contains and which the
// scanner itself gates on. A unit test pins TESTID_TRIGGER to it (#1526).
//
// The logic lives here (rather than inline in bash) so the two fragile parts —
// the trigger predicate and locating a usable Python interpreter across
// platforms (Windows ships a `python`/`python3` App-Execution-Alias stub that is
// NOT a real interpreter) — can be unit-tested. See regen-testid-catalog.test.mjs.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

/** Filename suffixes that are tests/fixtures/decls, not app UI (mirrors the Python scanner). */
const SKIP_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts"];

/** Path segments whose contents are tests/mocks/plumbing, not app UI. */
const SKIP_DIR_PARTS = new Set(["__tests__", "test", "__mocks__", "testbridge"]);

/**
 * Pattern whose presence means the file may contribute a testid.
 *
 * Mirrors `_TRIGGER` in `scripts/build-testid-catalog.py`. Every sink form the
 * generator scans contains it: the `data-testid` attribute (also as an object
 * key or via `setAttribute("data-testid", …)`), any `*TestId` prop/variable/key
 * (#1431, #3044), and `*TestIdPrefix` row-family stems. The generator skips any
 * text that does not match it, so a sink it catalogs can never be missed here.
 * A unit test pins this pattern to the Python one so the two cannot drift (#1526).
 */
export const TESTID_TRIGGER = /[Tt]est[Ii]d/;

/**
 * Whether `contents` may carry a test id, per {@link TESTID_TRIGGER}.
 *
 * @param {string} contents - The file's text contents.
 * @returns {boolean}
 */
export function containsTestId(contents) {
  return TESTID_TRIGGER.test(contents);
}

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
 * test/spec/decl/mock and matches {@link TESTID_TRIGGER}.
 *
 * Deliberately coarser than the Python scanner: it checks for the trigger
 * pattern alone, not a full sink `name=<value>` match. A false positive costs one
 * redundant (idempotent) generator run; a false negative leaves a stale
 * catalog, so the gate errs toward regenerating.
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
  return containsTestId(contents);
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
if (isMainModule(import.meta.url)) {
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
