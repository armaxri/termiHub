#!/usr/bin/env node
// The instrumented plugin runner a coverage run should spawn (#4693), for
// scripts/coverage.sh / coverage.cmd.
//
// Why: core's out-of-process plugin suites (core/tests/plugin_runner_*) drive
// the full host path through a real `termihub-plugin-runner` process. Left to
// themselves they build that runner into cargo's private CARGO_TARGET_TMPDIR,
// which `cargo llvm-cov report` never scans for objects, so none of the lines
// those runners execute count toward plugin-runner coverage. `cargo llvm-cov
// --workspace` already builds an instrumented runner binary into its own
// target dir (<cargo target dir>/llvm-cov-target/debug/); the coverage scripts
// export TERMIHUB_PLUGIN_RUNNER pointing at it, so the suites spawn that one
// and its profile is merged into the report. (The host forwards
// LLVM_PROFILE_FILE to the runner and the runner grants its folder only in a
// `cfg(coverage)` build, see core/src/plugin/sandbox/spawn.rs.)
//
// Usage: node scripts/internal/llvm-cov-runner-path.mjs   → prints the path
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";

/** The runner path inside the llvm-cov target dir of `targetDirectory`. */
export function runnerPath(targetDirectory, platform = process.platform) {
  const exe = platform === "win32" ? ".exe" : "";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(targetDirectory, "llvm-cov-target", "debug", `termihub-plugin-runner${exe}`);
}

/** The workspace's cargo target directory, from `cargo metadata`. */
export function cargoTargetDirectory(metadataJson) {
  const dir = JSON.parse(metadataJson).target_directory;
  if (typeof dir !== "string" || dir === "") {
    throw new Error("cargo metadata reported no target_directory");
  }
  return dir;
}

if (isMainModule(import.meta.url)) {
  const metadata = execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  console.log(runnerPath(cargoTargetDirectory(metadata)));
}
