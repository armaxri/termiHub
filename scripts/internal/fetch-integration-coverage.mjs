#!/usr/bin/env node
// Fetch the newest nightly integration-lane coverage for a branch (TOOL-005,
// #3656). Used by the advisory Coverage workflow (coverage.yml) before it runs
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
// ADVISORY: every "nothing usable" outcome (no run yet, artifact expired, the
// commit cannot be fetched, gh/git unavailable) prints a note and exits 0 with
// no lcov written, so the unified report simply falls back to unit coverage.
//
// Usage: node fetch-integration-coverage.mjs --repo <owner/name> --branch <b>
//          --out-dir <dir>
// Needs GH_TOKEN with `actions: read` (for the run/artifact API).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW = "integration-fixtures.yml";
export const ARTIFACT = "integration-coverage";
export const LCOV_NAME = "integration.lcov";
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
export function pickArtifact(artifacts) {
  return artifacts.find((a) => a.name === ARTIFACT && !a.expired) ?? null;
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

    // Stale-file list: the lcov's line numbers are only trustworthy for files
    // identical at the nightly commit and HEAD.
    let diff;
    try {
      exec("git", ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", run.head_sha]);
      diff = exec("git", ["diff", "--name-only", run.head_sha, "HEAD"]);
    } catch (e) {
      log(`note: cannot diff ${run.head_sha} against HEAD (${firstLine(e)}); unit coverage only.`);
      return null;
    }
    const staleList = path.join(outDir, "stale-files.txt");
    const body = staleListFrom(diff);
    writeFileSync(staleList, body);
    const staleCount = body.split("\n").filter(Boolean).length;
    log(
      `integration coverage: run ${run.id} (${run.event}, ${run.conclusion}) at ` +
        `${run.head_sha.slice(0, 12)}; ${staleCount} file(s) changed since.`
    );
    return { lcov, staleList, run };
  }

  log(`note: no ${WORKFLOW} nightly run on '${branch}' with a live '${ARTIFACT}' artifact yet.`);
  return null;
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
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
