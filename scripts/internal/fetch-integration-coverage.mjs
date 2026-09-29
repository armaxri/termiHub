#!/usr/bin/env node
// Fetch the newest nightly integration-lane coverage for a branch (TOOL-005,
// #3656). Used by the Coverage workflow (coverage.yml) before it runs
// scripts/coverage.sh, which then merges the lcov into the unified report.
//
// The integration-fixtures lane runs `core/tests` against live Docker fixtures
// under cargo-llvm-cov on its scheduled / manually dispatched runs and uploads
// an `integration-coverage` artifact. This script:
//
//   1. lists that workflow's completed runs on --branch (newest first) and picks
//      the newest non-PR run (schedule / workflow_dispatch) that still has an
//      unexpired coverage artifact — a run whose tests failed still measured
//      what it executed, so `failure` counts; `cancelled` does not;
//   2. downloads the artifact into --out-dir;
//   3. fetches that run's commit and writes `stale-files.txt` — every file that
//      changed between it and HEAD — so lcov-merge.mjs skips files whose line
//      numbers may have moved.
//
// It then does the same for the Python bridge harness lane (#3657): the
// system-integration workflow's Linux leg uploads `harness-coverage-<branch>`
// (frontend Istanbul + src-tauri llvm-cov lcov, scripts/internal/
// harness-coverage.sh). That workflow's SCHEDULED runs are recorded against
// main even when they grade develop, so the artifact is picked by its
// branch-suffixed NAME rather than by the run's branch, and the measured commit
// comes from the artifact's own harness-coverage.json, not the run's head_sha.
// It lands in <out-dir>/harness/ (harness.lcov + stale-files.txt).
//
// ADVISORY: every "nothing usable" outcome (no run yet, artifact expired, the
// commit cannot be fetched, gh/git unavailable) prints a note and exits 0 with
// no lcov written, so the unified report simply falls back to unit coverage.
//
// Usage: node fetch-integration-coverage.mjs --repo <owner/name> --branch <b>
//          --out-dir <dir>
// Needs GH_TOKEN with `actions: read` (for the run/artifact API).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";

export const WORKFLOW = "integration-fixtures.yml";
export const ARTIFACT = "integration-coverage";
export const LCOV_NAME = "integration.lcov";
export const HARNESS_WORKFLOW = "system-integration.yml";
export const HARNESS_LCOV = "harness.lcov";
export const HARNESS_META = "harness-coverage.json";
export const HARNESS_SUBDIR = "harness";
const SHA_RE = /^[0-9a-f]{40}$/;

/** The harness lane's coverage artifact name for a graded branch (or sha). */
export function harnessArtifactName(branch) {
  return `harness-coverage-${branch}`;
}
const NIGHTLY_EVENTS = new Set(["schedule", "workflow_dispatch"]);
const USABLE_CONCLUSIONS = new Set(["success", "failure"]);

/** Non-PR, completed, not-cancelled runs, newest first. */
export function candidateRuns(runs) {
  return runs
    .filter(
      (r) =>
        NIGHTLY_EVENTS.has(r.event) &&
        r.status === "completed" &&
        USABLE_CONCLUSIONS.has(r.conclusion)
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** The run's coverage artifact, if it was uploaded and has not expired. */
export function pickArtifact(artifacts, name = ARTIFACT) {
  return artifacts.find((a) => a.name === name && !a.expired) ?? null;
}

/** Normalize `git diff --name-only` output into a skip-list body. */
export function staleListFrom(diffOutput) {
  const files = diffOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return files.length > 0 ? files.join("\n") + "\n" : "";
}

export function parseArgs(argv) {
  const opts = {};
  const names = { "--repo": "repo", "--branch": "branch", "--out-dir": "outDir" };
  for (let i = 0; i < argv.length; i++) {
    const name = names[argv[i]];
    if (!name || i + 1 >= argv.length) throw new Error(`bad argument: ${argv[i]}`);
    opts[name] = argv[++i];
  }
  for (const req of ["repo", "branch", "outDir"]) {
    if (!opts[req]) throw new Error(`--${req === "outDir" ? "out-dir" : req} is required`);
  }
  return opts;
}

function defaultExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Resolve, download and stale-check the newest usable integration coverage.
 * `exec(cmd, args)` returns stdout and throws on failure (injectable for tests).
 * Returns { lcov, staleList, run } or null when nothing usable exists.
 */
export function fetchIntegrationCoverage(
  { repo, branch, outDir },
  exec = defaultExec,
  log = console.log
) {
  let runs;
  try {
    const json = exec("gh", [
      "api",
      "-X",
      "GET",
      `repos/${repo}/actions/workflows/${WORKFLOW}/runs`,
      "-f",
      `branch=${branch}`,
      "-f",
      "status=completed",
      "-f",
      "per_page=30",
    ]);
    runs = candidateRuns(JSON.parse(json).workflow_runs ?? []);
  } catch (e) {
    log(`note: could not list ${WORKFLOW} runs (${firstLine(e)}); unit coverage only.`);
    return null;
  }

  for (const run of runs) {
    let artifact;
    try {
      const json = exec("gh", ["api", `repos/${repo}/actions/runs/${run.id}/artifacts`]);
      artifact = pickArtifact(JSON.parse(json).artifacts ?? []);
    } catch (e) {
      log(`note: could not list artifacts of run ${run.id} (${firstLine(e)}).`);
      continue;
    }
    if (!artifact) continue;

    mkdirSync(outDir, { recursive: true });
    try {
      exec("gh", ["run", "download", String(run.id), "-R", repo, "-n", ARTIFACT, "-D", outDir]);
    } catch (e) {
      log(`note: download of run ${run.id} failed (${firstLine(e)}); unit coverage only.`);
      return null;
    }
    const lcov = path.join(outDir, LCOV_NAME);
    if (!existsSync(lcov)) {
      log(`note: run ${run.id}'s artifact has no ${LCOV_NAME}; unit coverage only.`);
      return null;
    }

    const stale = writeStaleList(run.head_sha, outDir, exec, log);
    if (!stale) return null;
    log(
      `integration coverage: run ${run.id} (${run.event}, ${run.conclusion}) at ` +
        `${run.head_sha.slice(0, 12)}; ${stale.count} file(s) changed since.`
    );
    return { lcov, staleList: stale.path, run };
  }

  log(`note: no ${WORKFLOW} nightly run on '${branch}' with a live '${ARTIFACT}' artifact yet.`);
  return null;
}

/**
 * Write `<outDir>/stale-files.txt`: every file changed between the measured
 * commit and HEAD. The lcov's line numbers are only trustworthy for files that
 * are identical at both. Returns { path, count } or null when the commit cannot
 * be fetched/diffed.
 */
function writeStaleList(sha, outDir, exec, log) {
  let diff;
  try {
    exec("git", ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", sha]);
    diff = exec("git", ["diff", "--name-only", sha, "HEAD"]);
  } catch (e) {
    log(`note: cannot diff ${sha} against HEAD (${firstLine(e)}); unit coverage only.`);
    return null;
  }
  const staleList = path.join(outDir, "stale-files.txt");
  const body = staleListFrom(diff);
  writeFileSync(staleList, body);
  return { path: staleList, count: body.split("\n").filter(Boolean).length };
}

/**
 * Resolve, download and stale-check the newest usable harness-lane coverage
 * for `branch` (#3657) into `outDir`. Same contract as
 * fetchIntegrationCoverage: returns { lcov, staleList, run, sha } or null.
 */
export function fetchHarnessCoverage(
  { repo, branch, outDir },
  exec = defaultExec,
  log = console.log
) {
  const name = harnessArtifactName(branch);
  let runs;
  try {
    // No branch filter: a scheduled run is recorded on main whatever it grades.
    const json = exec("gh", [
      "api",
      "-X",
      "GET",
      `repos/${repo}/actions/workflows/${HARNESS_WORKFLOW}/runs`,
      "-f",
      "status=completed",
      "-f",
      "per_page=30",
    ]);
    runs = candidateRuns(JSON.parse(json).workflow_runs ?? []);
  } catch (e) {
    log(`note: could not list ${HARNESS_WORKFLOW} runs (${firstLine(e)}); no harness coverage.`);
    return null;
  }

  for (const run of runs) {
    let artifact;
    try {
      const json = exec("gh", ["api", `repos/${repo}/actions/runs/${run.id}/artifacts`]);
      artifact = pickArtifact(JSON.parse(json).artifacts ?? [], name);
    } catch (e) {
      log(`note: could not list artifacts of run ${run.id} (${firstLine(e)}).`);
      continue;
    }
    if (!artifact) continue;

    mkdirSync(outDir, { recursive: true });
    try {
      exec("gh", ["run", "download", String(run.id), "-R", repo, "-n", name, "-D", outDir]);
    } catch (e) {
      log(`note: download of run ${run.id} failed (${firstLine(e)}); no harness coverage.`);
      return null;
    }
    const lcov = path.join(outDir, HARNESS_LCOV);
    const sha = readMeasuredSha(path.join(outDir, HARNESS_META));
    if (!existsSync(lcov) || !sha) {
      log(`note: run ${run.id}'s ${name} lacks ${HARNESS_LCOV} or a valid sha; skipped.`);
      return null;
    }
    const stale = writeStaleList(sha, outDir, exec, log);
    if (!stale) return null;
    log(
      `harness coverage: run ${run.id} (${run.event}, ${run.conclusion}) measured ` +
        `${sha.slice(0, 12)}; ${stale.count} file(s) changed since.`
    );
    return { lcov, staleList: stale.path, run, sha };
  }

  log(`note: no ${HARNESS_WORKFLOW} run with a live '${name}' artifact yet.`);
  return null;
}

/** The measured commit from a harness-coverage.json, or null. */
export function readMeasuredSha(metaPath) {
  try {
    const sha = JSON.parse(readFileSync(metaPath, "utf8")).sha;
    return typeof sha === "string" && SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function firstLine(e) {
  return String(e?.stderr || e?.message || e)
    .split("\n")[0]
    .trim();
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`fetch-integration-coverage: ${e.message}`);
    console.error(
      "usage: fetch-integration-coverage.mjs --repo <owner/name> --branch <b> --out-dir <dir>"
    );
    return 2;
  }
  fetchIntegrationCoverage(opts);
  fetchHarnessCoverage({ ...opts, outDir: path.join(opts.outDir, HARNESS_SUBDIR) });
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
