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
// What this file *does* duplicate is the generator's notion of which files and
// attributes carry a testid (SKIP_* and TESTID_ATTRS below). That copy can
// drift from the scanner — it did when #1431 added the forwarding props — so
// TESTID_ATTRS is pinned to the Python `_TESTID_ATTRS` by a unit test.
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

/**
 * Attributes/props whose presence means the file may contribute a testid.
 *
 * Mirrors `_TESTID_ATTRS` in `scripts/build-testid-catalog.py`: the literal DOM
 * attribute plus the shared sidebar shell's forwarding props, which consumers
 * use instead of a raw `data-testid` (#1431). Gating on `data-testid` alone
 * skipped those consumers entirely. A unit test pins this list to the Python
 * one so the two cannot drift apart again (#1526).
 */
export const TESTID_ATTRS = ["data-testid", "testId", "nameTestId", "badgeTestId"];

/** A JS identifier character — used for the word boundary before an attribute name. */
const IDENT = /[A-Za-z0-9_$]/;

/**
 * Whether `contents` mentions any test-id attribute/prop from {@link TESTID_ATTRS}
 * as a standalone name.
 *
 * The name must be delimited by non-identifier characters on both sides. This
 * mirrors the Python scanner's boundary rules: it requires a non-identifier
 * char before the name (so `testId` does not match inside `nameTestId`) and an
 * `=` after it (so it does not match inside `testIdPrefix`). Checking for any
 * non-identifier char rather than `=` specifically keeps the gate deliberately
 * loose — `testId ={x}` and `testId\n  ={x}` still trigger — while still
 * rejecting the identifier-substring false positives.
 *
 * @param {string} contents - The file's text contents.
 * @returns {boolean}
 */
export function containsTestId(contents) {
  return TESTID_ATTRS.some((attr) => {
    let from = 0;
    for (;;) {
      const at = contents.indexOf(attr, from);
      if (at < 0) {
        return false;
      }
      const after = at + attr.length;
      const boundedBefore = at === 0 || !IDENT.test(contents[at - 1]);
      const boundedAfter = after >= contents.length || !IDENT.test(contents[after]);
      if (boundedBefore && boundedAfter) {
        return true;
      }
      from = after;
    }
  });
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
 * test/spec/decl/mock and mentions one of {@link TESTID_ATTRS}.
 *
 * Deliberately coarser than the Python scanner: it checks for the attribute
 * name alone, not a full `name=<value>` match. A false positive costs one
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
