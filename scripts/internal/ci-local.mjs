/**
 * Shared helper for scripts/ci-local.sh and scripts/ci-local.cmd (#4358,
 * TOOL2-004). Both halves call it, so anything that would otherwise be a
 * hand-maintained list in two places lives here once:
 *
 *   node scripts/internal/ci-local.mjs core-features
 *       Every opt-in termihub-core feature, one per line, read from
 *       `cargo metadata` exactly as code-quality.yml's isolation step does. The
 *       old hard-coded "keep in sync" list had silently fallen six features
 *       behind core/Cargo.toml.
 *
 *   node scripts/internal/ci-local.mjs shellcheck
 *       ShellCheck (severity warning) over the tracked shell scripts the
 *       `Shell Script Quality` job scans. Exits 127 when shellcheck is absent so
 *       the caller can report the gate as skipped.
 *
 *   node scripts/internal/ci-local.mjs not-reproduced
 *       The per-PR CI jobs (and parts of jobs) ci-local deliberately does not
 *       reproduce, one per line, for the closing summary.
 *
 * CI_LOCAL_JOBS maps every job of .github/workflows/code-quality.yml to the
 * ci-local gates that reproduce it, or to the reason it is not reproduced.
 * ci-local.test.mjs fails when a job is added or removed without updating the
 * map, and when a named gate is missing from either script.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * code-quality.yml job id -> how ci-local covers it. `gates` are the exact
 * gate titles printed by both ci-local.sh and ci-local.cmd; `omitted` names the
 * part of a reproduced job that is not; `notReproduced` is why a whole job is
 * left out.
 * @type {Record<string, { gates?: string[], omitted?: string, notReproduced?: string }>}
 */
export const CI_LOCAL_JOBS = {
  changes: {
    notReproduced: "Detect Changed Areas: ci-local always runs every gate",
  },
  "rust-quality": {
    gates: [
      "Quality checks",
      "Rust: pre-release crates reviewed",
      "Rust: core opt-in features in isolation",
      "Rust: ts-rs bindings not stale",
      "Rust: IPC wire fixtures not stale",
      "Rust: unused dependencies (cargo-machete)",
      "Package example plugins",
    ],
  },
  "rust-quality-windows": {
    notReproduced:
      "Rust Code Quality (Windows): Windows-target clippy needs a Windows host " +
      "(ci-local.cmd's check.cmd clippy is its equivalent there)",
  },
  "rdp-sidecar-quality": {
    gates: ["RDP sidecar: fmt + clippy + tests", "RDP sidecar: cargo deny"],
  },
  "frontend-quality": {
    gates: [
      "Quality checks",
      "Frontend: TypeScript (tsc --noEmit)",
      "Frontend: manual-test inventory",
      "Version sources + Tauri drift",
    ],
    omitted: "Frontend Code Quality: the advisory knip report",
  },
  "bundle-size": { gates: ["Frontend: bundle size budget"] },
  rustdoc: { gates: ["Rust: rustdoc (-D warnings)"] },
  "plugin-fuzz-check": { gates: ["Plugin IPC fuzz crate (fmt + clippy)"] },
  shellcheck: {
    gates: [
      "Shell: ShellCheck",
      "Shell: script parity (.sh <-> .cmd)",
      "Shell: headless smoke (--help paths)",
    ],
  },
  actionlint: { gates: ["Workflow lint (actionlint)"] },
  "cmd-scripts-windows": {
    notReproduced: "Windows cmd Script Smoke: runs on a Windows CI runner only",
  },
  tests: {
    gates: ["Rust workspace: cargo test", "Frontend: vitest + coverage floors"],
    omitted:
      "Run Tests: the Windows/macOS legs and the ci-rust-tests.sh bulk/serial " +
      "split (this host's OS only, one cargo test run)",
  },
  "agent-live-windows": {
    notReproduced: "Agent Live Tests (Windows, serial): needs a Windows runner",
  },
  "system-test-machinery": {
    gates: ["System-test harness (machinery)", "Test inventory ratchet"],
  },
  "testid-drift-guard": { gates: ["Test-ID drift guard"] },
  "commit-lint": { gates: ["Commit messages (commitlint)"] },
  "pr-gate": {
    notReproduced: "PR Gate: aggregates the jobs above; the ci-local summary is its equivalent",
  },
};

/**
 * The top-level job ids of a workflow file, in order. Reads the `jobs:` block
 * line-wise (job ids sit at two-space indent), which is all the drift test needs.
 * @param {string} text - workflow YAML.
 * @returns {string[]}
 */
export function workflowJobIds(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf("jobs:");
  if (start < 0) return [];
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/**
 * The opt-in features of termihub-core from `cargo metadata` output: every
 * feature key except `default`, sorted. Mirrors the jq filter in
 * code-quality.yml's isolation step.
 * @param {{ packages: { name: string, features: Record<string, string[]> }[] }} metadata
 * @returns {string[]}
 */
export function coreFeatures(metadata) {
  const core = metadata.packages.find((pkg) => pkg.name === "termihub-core");
  if (!core) throw new Error("termihub-core not found in cargo metadata");
  return Object.keys(core.features)
    .filter((feature) => feature !== "default")
    .sort();
}

/** The not-reproduced lines for the closing summary. */
export function notReproducedLines() {
  return Object.values(CI_LOCAL_JOBS).flatMap((job) =>
    [job.notReproduced, job.omitted].filter(Boolean)
  );
}

const SHELL_EXTENSIONS = /\.(sh|bash|ksh)$/;
const SHELL_SHEBANG = /^#!\s*\S*\/(env\s+)?(ba|k|da)?sh(\s|$)/;
const SHELLCHECK_SKIP_ROOTS = ["node_modules/", "target/", "graft/"];

/**
 * Whether a tracked path is a shell script ShellCheck should scan: a shell
 * extension, or an extension-less file with a sh/bash/ksh/dash shebang (the
 * executable hooks under scripts/hooks/).
 * @param {string} file - repo-relative path.
 * @param {(file: string) => string} readHead - returns the file's first line.
 */
export function isShellScript(file, readHead) {
  if (SHELLCHECK_SKIP_ROOTS.some((root) => file.startsWith(root))) return false;
  if (SHELL_EXTENSIONS.test(file)) return true;
  if (path.posix.basename(file).includes(".")) return false;
  return SHELL_SHEBANG.test(readHead(file));
}

function firstLine(file) {
  try {
    const full = path.join(REPO_ROOT, file);
    if (!statSync(full).isFile()) return "";
    return readFileSync(full, "utf8").split("\n", 1)[0];
  } catch {
    return "";
  }
}

function runShellcheck() {
  const probe = spawnSync("shellcheck", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) return 127;
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const files = tracked.filter((file) => isShellScript(file, firstLine));
  console.log(`shellcheck --severity=warning over ${files.length} tracked scripts`);
  const run = spawnSync("shellcheck", ["--severity=warning", ...files], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  return run.status ?? 1;
}

function main(command) {
  switch (command) {
    case "core-features": {
      const metadata = JSON.parse(
        execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        })
      );
      const features = coreFeatures(metadata);
      if (features.length === 0) throw new Error("termihub-core declares no opt-in features");
      console.log(features.join("\n"));
      return 0;
    }
    case "shellcheck":
      return runShellcheck();
    case "not-reproduced":
      console.log(notReproducedLines().join("\n"));
      return 0;
    default:
      console.error("usage: ci-local.mjs core-features | shellcheck | not-reproduced");
      return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv[2]);
}
