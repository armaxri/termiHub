#!/usr/bin/env node
// Release integration gate (WA-CI-004, WA-CI-024, #3652).
//
// Per-PR CI deliberately runs a slim lane (#3325/#3326): the Python bridge
// integration lane, the Docker fixture lane and the agent live/Docker suites do
// not run on PRs (integration-fixtures only on a path filter), and the full lanes
// run nightly per branch. That trade-off is only safe if a release is never cut on
// per-PR green alone. This gate enforces it: the Release workflow calls it first,
// and it refuses to let the release proceed unless the exact commit being released
// has a green run of every REQUIRED_WORKFLOWS entry below.
//
// Why "a run on this sha" and not "the nightly was green": the nightly
// system-integration lane is scheduled from the default branch and checks out the
// branch it grades, so its run's head_sha is NOT the commit it tested. Only the
// Release Candidate workflow (dispatched on the release ref, grading github.sha)
// and the post-merge Code Quality / Dev Build push runs are keyed to the exact commit.
//
// scripts/release-check.sh / .cmd run the same gate from a workstation before the
// tag is pushed (RELEASE_GATE_LOCAL=1, token from `gh auth token`, #3750), so the
// maintainer learns about a missing or red lane before tagging, not after.
//
// The logic lives here (not inline in release.yml) so it can be unit-tested — see
// release-integration-gate.test.mjs.

import { appendFileSync } from "node:fs";

/**
 * The workflows that must be green on the release commit.
 *
 * - release-candidate.yml runs system-integration (bridge integration lane on
 *   Linux/macOS/Windows, the display-critical grades, the agent Docker suites)
 *   and integration-fixtures (core/tests against live Docker fixtures + polkit),
 *   with no path filter, on the dispatched ref.
 * - code-quality.yml's push run is the post-merge full lane: the three-OS test
 *   matrix and "Agent Live Tests (Windows, serial)". Only a `push` run counts —
 *   a pull_request run is path-filtered and never keyed to the merge commit.
 * - dev-build.yml's push run is the full cross-platform app build (every
 *   bundle target, CI-015). Per-PR Build is path-filtered and the Release
 *   workflow only builds after create-release, so without this a commit whose
 *   full build is red could still be tagged. It is cancel-in-progress, so a run
 *   superseded by a newer push concludes `cancelled` and fails the gate — re-run
 *   it (see docs/contributing.md).
 */
export const REQUIRED_WORKFLOWS = [
  {
    file: "release-candidate.yml",
    name: "Release Candidate: Full Integration",
    event: "workflow_dispatch",
  },
  {
    file: "code-quality.yml",
    name: "Code Quality (post-merge push run)",
    event: "push",
  },
  {
    file: "dev-build.yml",
    name: "Dev Build (post-merge full build)",
    event: "push",
  },
];

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Classify the runs of one required workflow for the release sha.
 *
 * The NEWEST run on the sha decides: a later red or still-running re-run
 * outranks an earlier green one, so a flaky pass cannot be cherry-picked past a
 * subsequent failure.
 *
 * @param {Array<object>} runs - `workflow_runs` from the Actions API.
 * @param {{ sha: string, event: string }} want
 * @returns {{ state: "ok" | "missing" | "pending" | "failed", run?: object }}
 */
export function classifyRuns(runs, { sha, event }) {
  const matching = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.head_sha === sha && r.event === event)
    .sort((a, b) => {
      const byTime = String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
      return byTime !== 0 ? byTime : (b.id ?? 0) - (a.id ?? 0);
    });
  if (matching.length === 0) {
    return { state: "missing" };
  }
  const latest = matching[0];
  if (latest.status !== "completed") {
    return { state: "pending", run: latest };
  }
  return { state: latest.conclusion === "success" ? "ok" : "failed", run: latest };
}

/**
 * Evaluate the gate from already-fetched runs.
 *
 * @param {{ sha: string, runsByWorkflow: Record<string, Array<object>>,
 *   required?: typeof REQUIRED_WORKFLOWS }} input
 * @returns {{ ok: boolean, results: Array<{ requirement: object, state: string, run?: object }> }}
 */
export function evaluateGate({ sha, runsByWorkflow, required = REQUIRED_WORKFLOWS }) {
  const results = required.map((requirement) => ({
    requirement,
    ...classifyRuns(runsByWorkflow[requirement.file], { sha, event: requirement.event }),
  }));
  return { ok: results.every((r) => r.state === "ok"), results };
}

/**
 * Render the gate verdict as log lines (GitHub `::error::` annotations for every
 * unmet requirement) plus remediation instructions.
 *
 * @param {ReturnType<typeof evaluateGate>} verdict
 * `local` is the workstation mode scripts/release-check.sh / .cmd use (#3750): plain
 * `FAIL:` lines instead of GitHub annotations, and "re-run release-check" instead of
 * "re-run this release's failed jobs".
 *
 * @param {{ sha: string, repo: string, refName?: string, runUrl?: string, runId?: string,
 *   local?: boolean }} ctx
 * @returns {string[]}
 */
export function formatReport(verdict, { sha, repo, refName, runUrl, runId, local = false }) {
  const lines = [`Release integration gate for ${refName ? `${refName} @ ` : ""}${sha}`];
  for (const { requirement, state, run } of verdict.results) {
    const where = run?.html_url ? ` — ${run.html_url}` : "";
    const detail =
      state === "ok"
        ? "green"
        : state === "missing"
          ? `no ${requirement.event} run on this commit`
          : state === "pending"
            ? `newest run is still ${run?.status ?? "running"}`
            : `newest run concluded ${run?.conclusion ?? "unknown"}`;
    const line = `${requirement.name} (${requirement.file}): ${detail}${where}`;
    lines.push(state === "ok" ? `  ok: ${line}` : `${local ? "FAIL: " : "::error::"}${line}`);
  }
  if (verdict.ok) {
    lines.push("All required integration lanes are green on the release commit.");
    return lines;
  }
  const ref = refName || sha;
  lines.push(
    "",
    "Refusing to release: the full integration lanes have not passed on this exact commit.",
    "Per-PR CI does not run them (slim PR lane, #3325), so per-PR green is not enough.",
    "To fix:",
    `  1. Run the full integration lanes on the release ref:`,
    `       gh workflow run release-candidate.yml --repo ${repo} --ref ${ref}`,
    "     (a missing Code Quality or Dev Build push run means the commit was never",
    "     pushed to main/develop — tag a commit that was, so the post-merge lanes grade it;",
    "     a Dev Build push run cancelled by a newer push is re-run with",
    `       gh run rerun <dev-build run id> --repo ${repo}`,
    "     a failed one is a broken full build: fix it and re-tag)",
    "  2. Wait for it to finish green; fix and re-tag on a red lane (do not bypass).",
    local
      ? "  3. Then re-run scripts/release-check.sh (or scripts\\release-check.cmd)."
      : runId
        ? `  3. Re-run this release's failed jobs: gh run rerun ${runId} --repo ${repo} --failed`
        : "  3. Re-run this release's failed jobs from the Actions tab."
  );
  if (runUrl) {
    lines.push(`     (${runUrl})`);
  }
  lines.push("See docs/contributing.md -> 'Release integration gate'.");
  return lines;
}

/**
 * Fetch every run of one workflow on the release sha.
 *
 * @param {{ repo: string, file: string, sha: string, event: string, token: string,
 *   apiUrl?: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<Array<object>>}
 */
export async function fetchRuns({ repo, file, sha, event, token, apiUrl, fetchImpl = fetch }) {
  const base = apiUrl || "https://api.github.com";
  const url =
    `${base}/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs` +
    `?head_sha=${sha}&event=${encodeURIComponent(event)}&per_page=100`;
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  // 404: the workflow file does not exist on the default branch (yet) — no run
  // can exist, which the gate reports as "missing" (still a hard failure).
  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return Array.isArray(json?.workflow_runs) ? json.workflow_runs : [];
}

/**
 * Run the gate end to end.
 *
 * @param {{ env: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *   log?: (line: string) => void }} args
 * @returns {Promise<number>} Process exit code: 0 pass, 1 gate failed, 2 usage/API error.
 */
export async function runGate({ env, fetchImpl = fetch, log = console.log }) {
  const sha = (env.RELEASE_SHA || env.GITHUB_SHA || "").trim().toLowerCase();
  const repo = (env.GITHUB_REPOSITORY || "").trim();
  const token = env.GITHUB_TOKEN || "";
  if (!SHA_RE.test(sha)) {
    log(`::error::release-integration-gate: RELEASE_SHA/GITHUB_SHA is not a commit sha: '${sha}'`);
    return 2;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) {
    log("::error::release-integration-gate: GITHUB_REPOSITORY and GITHUB_TOKEN are required");
    return 2;
  }

  const runsByWorkflow = {};
  try {
    for (const { file, event } of REQUIRED_WORKFLOWS) {
      runsByWorkflow[file] = await fetchRuns({
        repo,
        file,
        sha,
        event,
        token,
        apiUrl: env.GITHUB_API_URL,
        fetchImpl,
      });
    }
  } catch (err) {
    log(`::error::release-integration-gate: GitHub API error: ${err.message}`);
    return 2;
  }

  const verdict = evaluateGate({ sha, runsByWorkflow });
  const runId = env.GITHUB_RUN_ID;
  const runUrl =
    runId && env.GITHUB_SERVER_URL ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}` : "";
  const local = env.RELEASE_GATE_LOCAL === "1";
  const lines = formatReport(verdict, {
    sha,
    repo,
    refName: env.RELEASE_REF_NAME,
    runUrl,
    runId,
    local,
  });
  for (const line of lines) {
    log(line);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const summary = lines.map((l) => l.replace(/^::error::/, "FAIL: ")).join("\n");
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Release integration gate\n\n\`\`\`\n${summary}\n\`\`\`\n`
    );
  }
  return verdict.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGate({ env: process.env }).then(
    (code) => process.exit(code),
    (err) => {
      console.log(`::error::release-integration-gate: ${err?.stack ?? err}`);
      process.exit(2);
    }
  );
}
