#!/usr/bin/env node
// Release coverage summary (TOOL-005 follow-up, #3658). ADVISORY: never blocks.
//
// A release run shows, for the EXACT release commit:
//
//   * the unified coverage — unit tests (frontend + Rust) plus the Docker
//     fixtures integration lane — overall and per ratchet component, and
//   * the integration coverage-gap summary: the lines only the integration
//     lane reaches (lcov-merge.mjs's integration-gap report).
//
// Nothing here re-runs a test. Both inputs are artifacts of runs keyed to the
// release sha:
//
//   unit         the `coverage-unified` artifact (coverage-unified/unit.lcov) of
//                the newest Coverage (coverage.yml) push or dispatch run on the
//                sha. A run whose ratchet failed still measured everything, so
//                `failure` counts; `cancelled` does not.
//   integration  the `integration-coverage` artifact (integration.lcov) that the
//                instrumented integration-fixtures lane uploads inside a
//                Release Candidate run (release-candidate.yml calls it with
//                measure_coverage: true). Pass it with --integration-lcov when it
//                is already on disk (release-candidate.yml downloads it from its
//                own run); otherwise the newest Release Candidate run on the sha
//                is looked up and its artifact downloaded (release.yml).
//
// Both come from the same commit, so no file is stale and the merge
// (lcov-merge.mjs: unit report owns the denominator, hits summed) needs no skip
// list. Every "nothing usable" outcome — no run, expired artifact, gh
// unavailable, a malformed lcov — becomes a note in the summary, and the script
// exits 0: the calling job is continue-on-error as well, so a coverage hiccup
// can never red the release or the release gate.
//
// Writes to --out-dir: release-coverage.md (also appended to
// $GITHUB_STEP_SUMMARY), merged.lcov and integration-gap.md when both inputs
// exist.
//
// Usage: node release-coverage-summary.mjs --repo <owner/name> --sha <sha>
//          --out-dir <dir> [--integration-lcov <file>] [--ref <name>]
//          [--root <repo root>] [--baseline <coverage-baseline.json>]
// Needs GH_TOKEN with `actions: read`.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPONENTS, percentages, tallyLcov } from "./coverage-ratchet.mjs";
import { ARTIFACT as INTEGRATION_ARTIFACT, LCOV_NAME } from "./fetch-integration-coverage.mjs";
import { formatLcov, formatReport, mergeCoverage, parseLcov } from "./lcov-merge.mjs";
import { pct, summarizeLcov } from "./lcov-summary.mjs";

export const COVERAGE_WORKFLOW = "coverage.yml";
export const COVERAGE_ARTIFACT = "coverage-unified";
export const UNIT_LCOV = path.join("coverage-unified", "unit.lcov");
export const CANDIDATE_WORKFLOW = "release-candidate.yml";
export const BASELINE_PLATFORM = "linux";
export const GAP_TITLE = "Integration coverage gap (Docker fixtures lane, release commit)";

const USABLE_CONCLUSIONS = new Set(["success", "failure"]);
const SHA_RE = /^[0-9a-f]{40}$/;

/** Completed, not-cancelled runs of `events` on `sha`, newest first. */
export function runsForSha(runs, { sha, events }) {
  return (Array.isArray(runs) ? runs : [])
    .filter(
      (r) =>
        r &&
        r.head_sha === sha &&
        events.includes(r.event) &&
        r.status === "completed" &&
        USABLE_CONCLUSIONS.has(r.conclusion)
    )
    .sort((a, b) => {
      const byTime = Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0);
      return byTime !== 0 ? byTime : (b.id ?? 0) - (a.id ?? 0);
    });
}

function defaultExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function firstLine(e) {
  return String(e?.stderr || e?.message || e)
    .split("\n")[0]
    .trim();
}

/**
 * Find the newest usable run of `workflow` on `sha` that still carries an
 * unexpired `artifact`, and download that artifact into `dir`.
 * Returns { run, dir } or { note } when nothing usable exists.
 */
export function downloadArtifactForSha({ repo, sha, workflow, events, artifact, dir }, exec) {
  let runs;
  try {
    const json = exec("gh", [
      "api",
      "-X",
      "GET",
      `repos/${repo}/actions/workflows/${workflow}/runs`,
      "-f",
      `head_sha=${sha}`,
      "-f",
      "status=completed",
      "-f",
      "per_page=30",
    ]);
    runs = runsForSha(JSON.parse(json).workflow_runs, { sha, events });
  } catch (e) {
    return { note: `could not list ${workflow} runs (${firstLine(e)})` };
  }
  for (const run of runs) {
    let found;
    try {
      const json = exec("gh", ["api", `repos/${repo}/actions/runs/${run.id}/artifacts`]);
      found = (JSON.parse(json).artifacts ?? []).find((a) => a.name === artifact && !a.expired);
    } catch {
      continue;
    }
    if (!found) continue;
    mkdirSync(dir, { recursive: true });
    try {
      exec("gh", ["run", "download", String(run.id), "-R", repo, "-n", artifact, "-D", dir]);
    } catch (e) {
      return { note: `download of ${workflow} run ${run.id} failed (${firstLine(e)})` };
    }
    return { run, dir };
  }
  return {
    note: `no completed ${workflow} run (${events.join("/")}) on this commit has a live '${artifact}' artifact`,
  };
}

/**
 * Compute unit, integration-only and unified coverage from lcov texts. Either
 * text may be null. Returns totals (LF/LH/FNF/FNH/BRF/BRH) per scope, per-
 * component line percentages, and lcov-merge's stats when both exist.
 */
export function computeCoverage({ unitText, integrationText, root }) {
  const result = { unit: null, integration: null, unified: null, components: [], stats: null };
  if (integrationText) result.integration = summarizeLcov(integrationText);
  if (!unitText) return result;

  result.unit = summarizeLcov(unitText);
  let unifiedText = null;
  if (integrationText) {
    const { merged, stats } = mergeCoverage(
      parseLcov(unitText, root),
      parseLcov(integrationText, root)
    );
    unifiedText = formatLcov(merged);
    result.unified = summarizeLcov(unifiedText);
    result.unifiedText = unifiedText;
    result.stats = stats;
  }
  const unitPct = percentages(tallyLcov([unitText], root));
  const unifiedPct = unifiedText ? percentages(tallyLcov([unifiedText], root)) : null;
  result.components = COMPONENTS.map((component) => ({
    component,
    unit: unitPct[component],
    unified: unifiedPct ? unifiedPct[component] : null,
  })).filter((c) => c.unit !== null);
  return result;
}

const fmtPct = (x) => (x === null || x === undefined ? "—" : `${x.toFixed(2)}%`);
const cell = (hit, found) => (found > 0 ? `${pct(hit, found).toFixed(2)}% (${hit}/${found})` : "—");
const row = (label, t) =>
  `| ${label} | ${cell(t.LH, t.LF)} | ${cell(t.FNH, t.FNF)} | ${cell(t.BRH, t.BRF)} |`;

function runLink(serverUrl, repo, run) {
  const label = `run ${run.id}`;
  const url = run.html_url || (serverUrl ? `${serverUrl}/${repo}/actions/runs/${run.id}` : "");
  return `${url ? `[${label}](${url})` : label} (${run.event}, ${run.conclusion})`;
}

/** The markdown summary for the job summary and the release-coverage artifact. */
export function formatMarkdown({
  sha,
  ref,
  repo,
  serverUrl,
  result,
  unitRun,
  integrationSource,
  notes,
  baseline,
}) {
  const lines = [
    "## Release coverage (advisory)",
    "",
    `Commit \`${sha.slice(0, 12)}\`${ref ? ` (${ref})` : ""}. Advisory only: this summary never ` +
      "blocks the release. The blocking coverage gate is the unit ratchet in the Coverage workflow.",
    "",
  ];

  if (result.unit) {
    lines.push("| Scope | Lines | Functions | Branches |", "| --- | ---: | ---: | ---: |");
    lines.push(row("Unit tests", result.unit));
    if (result.unified) lines.push(row("**Unified (unit + integration)**", result.unified));
    lines.push("");
    if (result.unified) {
      lines.push(
        `**UNIFIED LINE COVERAGE: ${pct(result.unified.LH, result.unified.LF).toFixed(2)}%** ` +
          `(unit only: ${pct(result.unit.LH, result.unit.LF).toFixed(2)}%)`,
        ""
      );
    } else {
      lines.push(
        `**UNIT LINE COVERAGE: ${pct(result.unit.LH, result.unit.LF).toFixed(2)}%** ` +
          "(no integration coverage merged)",
        ""
      );
    }
    const base = baseline ?? {};
    lines.push(
      "| Component | Unit | Unified | Integration gain | Ratchet baseline (linux) |",
      "| --- | ---: | ---: | ---: | ---: |"
    );
    for (const c of result.components) {
      const gain =
        c.unified === null || c.unit === null ? "—" : `+${(c.unified - c.unit).toFixed(2)} pp`;
      const b = base[c.component];
      lines.push(
        `| ${c.component} | ${fmtPct(c.unit)} | ${fmtPct(c.unified)} | ${gain} | ` +
          `${b === undefined ? "—" : fmtPct(b)} |`
      );
    }
    lines.push("");
  } else if (result.integration) {
    lines.push(
      "No unit coverage for this commit, so there is no unified number. " +
        "Integration lane on its own (`termihub-core` only):",
      "",
      "| Scope | Lines | Functions | Branches |",
      "| --- | ---: | ---: | ---: |",
      row("Integration lane", result.integration),
      ""
    );
  } else {
    lines.push("_No coverage data was available for this commit._", "");
  }

  if (result.stats) {
    lines.push(formatReport(result.stats, { title: GAP_TITLE }).replace(/^## /, "### "));
  }

  lines.push("### Sources", "");
  lines.push(
    `- Unit: ${unitRun ? `Coverage ${runLink(serverUrl, repo, unitRun)}, \`${UNIT_LCOV.replace(/\\/g, "/")}\`` : "none"}`
  );
  lines.push(`- Integration: ${integrationSource ?? "none"}`);
  if (notes.length > 0) {
    lines.push("", "### Notes", "");
    for (const n of notes) lines.push(`- ${n}`);
  }
  return lines.join("\n") + "\n";
}

const FLAGS = {
  "--repo": "repo",
  "--sha": "sha",
  "--out-dir": "outDir",
  "--integration-lcov": "integrationLcov",
  "--ref": "ref",
  "--root": "root",
  "--baseline": "baseline",
};

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const name = FLAGS[argv[i]];
    if (!name || i + 1 >= argv.length) throw new Error(`bad argument: ${argv[i]}`);
    opts[name] = argv[++i];
  }
  for (const req of ["repo", "sha", "outDir"]) {
    if (!opts[req]) throw new Error(`--${req === "outDir" ? "out-dir" : req} is required`);
  }
  opts.sha = opts.sha.trim().toLowerCase();
  if (!SHA_RE.test(opts.sha)) throw new Error(`--sha is not a commit sha: '${opts.sha}'`);
  return opts;
}

function readBaseline(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).platforms?.[BASELINE_PLATFORM] ?? null;
  } catch {
    return null;
  }
}

function readIfPresent(file) {
  return file && existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * Resolve both inputs, compute, and write the summary. Always returns 0 once
 * the arguments parse (advisory); `exec` and `env` are injectable for tests.
 */
export function runSummary(
  opts,
  { exec = defaultExec, env = process.env, log = console.log } = {}
) {
  const { repo, sha, outDir } = opts;
  const root = opts.root ?? env.GITHUB_WORKSPACE ?? process.cwd();
  const notes = [];
  mkdirSync(outDir, { recursive: true });

  // Unit coverage: the Coverage workflow's artifact for this exact commit.
  const unitDl = downloadArtifactForSha(
    {
      repo,
      sha,
      workflow: COVERAGE_WORKFLOW,
      events: ["push", "workflow_dispatch"],
      artifact: COVERAGE_ARTIFACT,
      dir: path.join(outDir, "unit"),
    },
    exec
  );
  let unitText = null;
  let unitRun = null;
  if (unitDl.note) {
    notes.push(
      `Unit coverage unavailable: ${unitDl.note}. Produce it with ` +
        `\`gh workflow run ${COVERAGE_WORKFLOW} --repo ${repo} --ref ${opts.ref || "<release ref>"}\`` +
        " and re-run this job."
    );
  } else {
    unitText = readIfPresent(path.join(unitDl.dir, UNIT_LCOV));
    if (unitText) unitRun = unitDl.run;
    else notes.push(`Coverage run ${unitDl.run.id}'s artifact has no ${UNIT_LCOV}.`);
  }

  // Integration coverage: the candidate run's instrumented fixtures lane.
  let integrationText = null;
  let integrationSource = null;
  if (opts.integrationLcov) {
    integrationText = readIfPresent(opts.integrationLcov);
    if (integrationText) {
      integrationSource = `\`${INTEGRATION_ARTIFACT}\` artifact of this Release Candidate run`;
    } else {
      notes.push(
        `Integration coverage unavailable: no ${opts.integrationLcov} (the fixtures lane ` +
          "failed before measuring, or cargo-llvm-cov could not be installed)."
      );
    }
  } else {
    const intDl = downloadArtifactForSha(
      {
        repo,
        sha,
        workflow: CANDIDATE_WORKFLOW,
        events: ["workflow_dispatch"],
        artifact: INTEGRATION_ARTIFACT,
        dir: path.join(outDir, "integration"),
      },
      exec
    );
    if (intDl.note) {
      notes.push(`Integration coverage unavailable: ${intDl.note}.`);
    } else {
      integrationText = readIfPresent(path.join(intDl.dir, LCOV_NAME));
      if (integrationText) {
        integrationSource = `\`${INTEGRATION_ARTIFACT}\` artifact of Release Candidate ${runLink(env.GITHUB_SERVER_URL, repo, intDl.run)}`;
      } else {
        notes.push(`Release Candidate run ${intDl.run.id}'s artifact has no ${LCOV_NAME}.`);
      }
    }
  }

  let result;
  try {
    result = computeCoverage({ unitText, integrationText, root });
  } catch (e) {
    notes.push(`Could not compute coverage: ${firstLine(e)}.`);
    result = { unit: null, integration: null, unified: null, components: [], stats: null };
  }

  const markdown = formatMarkdown({
    sha,
    ref: opts.ref,
    repo,
    serverUrl: env.GITHUB_SERVER_URL,
    result,
    unitRun,
    integrationSource,
    notes,
    baseline: readBaseline(opts.baseline ?? path.join("scripts", "coverage-baseline.json")),
  });
  writeFileSync(path.join(outDir, "release-coverage.md"), markdown);
  if (result.unifiedText) writeFileSync(path.join(outDir, "merged.lcov"), result.unifiedText);
  if (result.stats) {
    writeFileSync(
      path.join(outDir, "integration-gap.md"),
      formatReport(result.stats, { title: GAP_TITLE })
    );
  }
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
    } catch (e) {
      log(`note: could not write the job summary (${firstLine(e)}).`);
    }
  }
  log(markdown);
  return 0;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`release-coverage-summary: ${e.message}`);
    console.error(
      "usage: release-coverage-summary.mjs --repo <owner/name> --sha <sha> --out-dir <dir> " +
        "[--integration-lcov <file>] [--ref <name>] [--root <dir>] [--baseline <json>]"
    );
    return 2;
  }
  return runSummary(opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
