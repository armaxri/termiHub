#!/usr/bin/env node
// Resilient `cargo llvm-cov report` for scripts/coverage.sh / coverage.cmd (#3740).
//
// Why: once the coverage job became a blocking ratchet, an intermittent
// llvm-profdata failure would red it for reasons unrelated to coverage. On CI
// roughly one in three runs of `cargo llvm-cov --workspace` died at the merge
// step with:
//
//   warning: .../termiHub-<pid>-<hash>_0.profraw: invalid instrumentation
//            profile data (file header is corrupt)
//   error: no profile can be merged
//
// i.e. every test PASSED, but one process's .profraw was truncated (a child
// process killed or still exiting while the profile was written). The coverage
// scripts therefore run the tests with `--no-report` and generate the report
// through this helper, which on that failure deletes the named corrupt .profraw
// file(s) and retries. Dropping one short-lived process's profile loses a
// negligible amount of coverage; failing the whole gate loses all of it.
//
// Usage: node scripts/internal/llvm-cov-report.mjs <output.lcov> [max-attempts]
import { spawnSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Extract the .profraw paths llvm-profdata reported as corrupt/invalid. */
export function corruptProfraws(stderr) {
  const out = new Set();
  const re = /^warning:\s+(.+?\.profraw):\s+(?:invalid|malformed|truncated|.*corrupt)/gim;
  for (const m of stderr.matchAll(re)) out.add(m[1].trim());
  return [...out];
}

function main(argv) {
  const [output, attemptsArg] = argv;
  if (!output) {
    console.error("usage: llvm-cov-report.mjs <output.lcov> [max-attempts]");
    return 2;
  }
  const maxAttempts = Number.parseInt(attemptsArg ?? "4", 10);
  const cargo = process.env.CARGO || "cargo";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = spawnSync(cargo, ["llvm-cov", "report", "--lcov", "--output-path", output], {
      encoding: "utf8",
      stdio: ["ignore", "inherit", "pipe"],
      shell: process.platform === "win32",
    });
    process.stderr.write(res.stderr ?? "");
    if (res.status === 0) return 0;
    const corrupt = corruptProfraws(res.stderr ?? "").filter((f) => existsSync(f));
    if (corrupt.length === 0) {
      console.error(`llvm-cov-report: report failed (exit ${res.status}) with no corrupt profile`);
      console.error("  to drop — not retrying.");
      return res.status || 1;
    }
    for (const f of corrupt) {
      console.error(`llvm-cov-report: dropping corrupt profile ${f} (attempt ${attempt})`);
      rmSync(f, { force: true });
    }
  }
  console.error(`llvm-cov-report: still failing after ${maxAttempts} attempts.`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
