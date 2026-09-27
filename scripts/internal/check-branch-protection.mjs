#!/usr/bin/env node
// Branch protection drift check (audit finding CI-017, #3675).
//
// Compares the live protection of each branch in .github/branch-protection.json
// with the committed expectation and prints a readable report. Dependency-free
// (Node 22 `fetch`); run weekly by .github/workflows/branch-protection.yml.
//
// Reading branch protection needs repository ADMIN read ("Administration: read"
// on a fine-grained token, or a classic token of a repo admin). The workflow's
// GITHUB_TOKEN cannot be granted that scope, so without the
// BRANCH_PROTECTION_TOKEN secret the API answers 403/404 and this script SKIPS
// with a clear notice (exit 0) instead of failing.
//
// Branch status in the JSON:
//   enforced — drift is an error (exit 1).
//   proposed — drift is reported as "not applied yet" (exit 0); the maintainer
//              applies it with scripts/internal/apply-branch-protection.sh and
//              then flips the status to "enforced".
//
// Usage:
//   node scripts/internal/check-branch-protection.mjs [--repo <owner/name>]
//        [--file <json>] [--branch <name>]... [--summary <md-file>]
//   node scripts/internal/check-branch-protection.mjs --payload <branch> [--file <json>]
//        Print the REST PUT body for <branch> (used by apply-branch-protection.sh).
//
// Token: BRANCH_PROTECTION_TOKEN, else GH_TOKEN, else GITHUB_TOKEN, else
// `gh auth token`. When BRANCH_PROTECTION_TOKEN is set, an unreadable response is
// an error (exit 2): a configured-but-broken secret must not read as "skipped". Exit codes: 0 no enforced drift (or skipped), 1 enforced
// drift, 2 usage/network/file error.
// The pure helpers are exported for unit testing (check-branch-protection.test.mjs).

import { execFileSync } from "child_process";
import { appendFileSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The committed expectation, relative to the repo root. */
export const DEFAULT_FILE = path.join(ROOT, ".github", "branch-protection.json");

export const DEFAULT_REPO = "armaxri/termiHub";

/** Boolean toggles compared one-to-one (live shape: `{ enabled: bool }`). */
export const TOGGLES = [
  "enforce_admins",
  "required_signatures",
  "required_linear_history",
  "allow_force_pushes",
  "allow_deletions",
  "block_creations",
  "required_conversation_resolution",
  "lock_branch",
  "allow_fork_syncing",
];

/** Review fields compared when a branch requires pull-request reviews. */
export const REVIEW_FIELDS = [
  "dismiss_stale_reviews",
  "require_code_owner_reviews",
  "require_last_push_approval",
  "required_approving_review_count",
];

const STATUSES = new Set(["enforced", "proposed"]);

/**
 * Parse and validate the expectation file.
 *
 * @param {string} text - JSON text of .github/branch-protection.json.
 * @returns {Record<string, { status: string, protection: object }>} branches
 */
export function parseExpected(text) {
  const doc = JSON.parse(text);
  const branches = doc?.branches;
  if (!branches || typeof branches !== "object" || Object.keys(branches).length === 0) {
    throw new Error("branch-protection.json: `branches` must be a non-empty object");
  }
  for (const [name, entry] of Object.entries(branches)) {
    if (!STATUSES.has(entry?.status)) {
      throw new Error(`branch-protection.json: ${name}.status must be "enforced" or "proposed"`);
    }
    const p = entry.protection;
    if (!p || typeof p !== "object") {
      throw new Error(`branch-protection.json: ${name}.protection is missing`);
    }
    for (const key of TOGGLES) {
      if (typeof p[key] !== "boolean") {
        throw new Error(`branch-protection.json: ${name}.protection.${key} must be a boolean`);
      }
    }
    const checks = p.required_status_checks;
    if (checks !== null) {
      if (typeof checks?.strict !== "boolean" || !Array.isArray(checks?.contexts)) {
        throw new Error(
          `branch-protection.json: ${name}.protection.required_status_checks needs strict + contexts (or null)`
        );
      }
    }
  }
  return branches;
}

/**
 * Reduce a GET .../branches/{b}/protection response to the expectation's shape.
 * `null` in, `null` out (the branch is not protected at all).
 *
 * @param {object | null} api
 * @returns {object | null}
 */
export function normalizeLive(api) {
  if (api === null) return null;
  const out = {};
  const rsc = api.required_status_checks;
  if (rsc) {
    const checks = Array.isArray(rsc.checks) ? rsc.checks : [];
    const appIds = [...new Set(checks.map((c) => c.app_id ?? null))];
    out.required_status_checks = {
      strict: Boolean(rsc.strict),
      app_id: appIds.length === 1 ? appIds[0] : appIds.length === 0 ? null : appIds,
      contexts: [...(rsc.contexts ?? checks.map((c) => c.context))],
    };
  } else {
    out.required_status_checks = null;
  }
  const reviews = api.required_pull_request_reviews;
  out.required_pull_request_reviews = reviews
    ? Object.fromEntries(REVIEW_FIELDS.map((k) => [k, reviews[k] ?? (k.endsWith("count") ? 0 : false)]))
    : null;
  out.restrictions = api.restrictions
    ? {
        users: (api.restrictions.users ?? []).map((u) => u.login).sort(),
        teams: (api.restrictions.teams ?? []).map((t) => t.slug).sort(),
        apps: (api.restrictions.apps ?? []).map((a) => a.slug).sort(),
      }
    : null;
  for (const key of TOGGLES) out[key] = Boolean(api[key]?.enabled);
  return out;
}

const show = (v) => (v === undefined ? "(unset)" : JSON.stringify(v));

/**
 * Compare an expectation with the normalized live protection.
 *
 * @param {object} expected - `branches.<name>.protection` from the JSON.
 * @param {object | null} live - normalizeLive() output.
 * @returns {string[]} human-readable drift lines; empty = no drift.
 */
export function diffProtection(expected, live) {
  if (live === null) return ["branch is NOT protected at all (expected protection rules)"];
  const lines = [];

  const e = expected.required_status_checks;
  const l = live.required_status_checks;
  if (e === null && l !== null) {
    lines.push(`required status checks: expected none, live requires ${show(l.contexts)}`);
  } else if (e !== null && l === null) {
    lines.push("required status checks: live requires none");
    for (const c of e.contexts) lines.push(`required check missing live: "${c}"`);
  } else if (e !== null && l !== null) {
    if (e.strict !== l.strict) {
      lines.push(`required status checks strict (up to date): expected ${e.strict}, live ${l.strict}`);
    }
    const want = new Set(e.contexts);
    const have = new Set(l.contexts);
    for (const c of e.contexts) if (!have.has(c)) lines.push(`required check missing live: "${c}"`);
    for (const c of l.contexts) if (!want.has(c)) lines.push(`required check live but not expected: "${c}"`);
    if (e.app_id !== undefined && l.contexts.length > 0 && JSON.stringify(e.app_id) !== JSON.stringify(l.app_id)) {
      lines.push(`required checks app_id: expected ${show(e.app_id)}, live ${show(l.app_id)}`);
    }
  }

  const er = expected.required_pull_request_reviews;
  const lr = live.required_pull_request_reviews;
  if ((er === null) !== (lr === null)) {
    lines.push(`pull request required: expected ${er !== null}, live ${lr !== null}`);
  } else if (er !== null) {
    for (const k of REVIEW_FIELDS) {
      if (er[k] !== lr[k]) lines.push(`pull request reviews ${k}: expected ${show(er[k])}, live ${show(lr[k])}`);
    }
  }

  if (expected.restrictions === null && live.restrictions !== null) {
    lines.push(`push restrictions: expected none, live ${show(live.restrictions)}`);
  } else if (expected.restrictions !== null && live.restrictions === null) {
    lines.push("push restrictions: expected some, live none");
  } else if (expected.restrictions !== null) {
    const want = JSON.stringify({
      users: [...(expected.restrictions.users ?? [])].sort(),
      teams: [...(expected.restrictions.teams ?? [])].sort(),
      apps: [...(expected.restrictions.apps ?? [])].sort(),
    });
    if (want !== JSON.stringify(live.restrictions)) {
      lines.push(`push restrictions: expected ${want}, live ${show(live.restrictions)}`);
    }
  }

  for (const key of TOGGLES) {
    if (expected[key] !== live[key]) lines.push(`${key}: expected ${expected[key]}, live ${live[key]}`);
  }
  return lines;
}

/**
 * The REST PUT body for a branch (PUT /repos/{o}/{r}/branches/{b}/protection).
 * `required_signatures` has its own endpoint and is not part of this body.
 *
 * @param {object} p - `branches.<name>.protection` from the JSON.
 * @returns {object}
 */
export function buildPutPayload(p) {
  const rsc = p.required_status_checks;
  return {
    required_status_checks:
      rsc === null
        ? null
        : {
            strict: rsc.strict,
            checks: rsc.contexts.map((context) =>
              rsc.app_id === undefined || rsc.app_id === null ? { context } : { context, app_id: rsc.app_id }
            ),
          },
    enforce_admins: p.enforce_admins,
    required_pull_request_reviews: p.required_pull_request_reviews,
    restrictions: p.restrictions,
    required_linear_history: p.required_linear_history,
    allow_force_pushes: p.allow_force_pushes,
    allow_deletions: p.allow_deletions,
    block_creations: p.block_creations,
    required_conversation_resolution: p.required_conversation_resolution,
    lock_branch: p.lock_branch,
    allow_fork_syncing: p.allow_fork_syncing,
  };
}

/**
 * Read one branch's protection.
 *
 * @returns {Promise<{ state: "ok", data: object } | { state: "unprotected" }
 *   | { state: "unreadable", message: string }>}
 * @throws on network errors, a missing branch, or unexpected HTTP statuses.
 */
export async function fetchProtection(repo, branch, { token, fetchImpl = fetch } = {}) {
  const url = `https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "termihub-branch-protection-check",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const message = body?.message ?? "";
  if (res.status === 200) return { state: "ok", data: body };
  if (res.status === 404 && message === "Branch not protected") return { state: "unprotected" };
  if (res.status === 404 && message === "Branch not found") {
    throw new Error(`branch "${branch}" does not exist in ${repo}`);
  }
  // 401/403, and the generic 404 GitHub returns to a caller without admin read.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { state: "unreadable", message: `HTTP ${res.status}${message ? `: ${message}` : ""}` };
  }
  throw new Error(`GET ${url}: HTTP ${res.status}${message ? `: ${message}` : ""}`);
}

/**
 * Check every requested branch and build the report.
 *
 * @returns {Promise<{ exitCode: number, report: string[], results: object[] }>}
 */
export async function run({ repo, branches, only = [], token, fetchImpl = fetch, requireReadable = false }) {
  const names = only.length > 0 ? only : Object.keys(branches);
  const report = [];
  const results = [];
  let enforcedDrift = false;
  for (const name of names) {
    const entry = branches[name];
    if (!entry) throw new Error(`branch "${name}" is not in branch-protection.json`);
    const got = await fetchProtection(repo, name, { token, fetchImpl });
    if (got.state === "unreadable" && requireReadable) {
      // A configured token that cannot read is a broken secret, not "no token".
      throw new Error(`${name}: the configured token cannot read branch protection (${got.message})`);
    }
    if (got.state === "unreadable") {
      results.push({ branch: name, status: entry.status, outcome: "skipped" });
      report.push(
        `SKIPPED ${name}: cannot read branch protection (${got.message}).`,
        "  Reading it needs admin read (fine-grained token: Administration = read-only).",
        "  Set the BRANCH_PROTECTION_TOKEN secret; GITHUB_TOKEN cannot be granted this."
      );
      continue;
    }
    const live = got.state === "ok" ? normalizeLive(got.data) : null;
    const drift = diffProtection(entry.protection, live);
    if (drift.length === 0) {
      results.push({ branch: name, status: entry.status, outcome: "match" });
      report.push(
        entry.status === "proposed"
          ? `MATCH ${name} (proposed): the proposal is live; flip its status to "enforced".`
          : `OK ${name}: live protection matches.`
      );
      continue;
    }
    if (entry.status === "enforced") {
      enforcedDrift = true;
      results.push({ branch: name, status: entry.status, outcome: "drift" });
      report.push(`DRIFT ${name} (enforced): ${drift.length} difference(s)`);
    } else {
      results.push({ branch: name, status: entry.status, outcome: "pending" });
      report.push(
        `PENDING ${name} (proposed, not applied yet): ${drift.length} difference(s)`,
        `  Apply: scripts/internal/apply-branch-protection.sh --branch ${name} --apply`
      );
    }
    for (const line of drift) report.push(`  - ${line}`);
  }
  return { exitCode: enforcedDrift ? 1 : 0, report, results };
}

/** Resolve a token from the environment, falling back to the gh CLI. */
export function resolveToken(env = process.env, exec = execFileSync) {
  const fromEnv = env.BRANCH_PROTECTION_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return exec("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Parse CLI arguments. */
export function parseArgs(argv) {
  const opts = { repo: DEFAULT_REPO, file: DEFAULT_FILE, only: [], summary: "", payload: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--repo") opts.repo = value();
    else if (arg === "--file") opts.file = value();
    else if (arg === "--branch") opts.only.push(value());
    else if (arg === "--summary") opts.summary = value();
    else if (arg === "--payload") opts.payload = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const branches = parseExpected(readFileSync(opts.file, "utf8"));
    if (opts.payload) {
      const entry = branches[opts.payload];
      if (!entry) throw new Error(`branch "${opts.payload}" is not in ${opts.file}`);
      process.stdout.write(`${JSON.stringify(buildPutPayload(entry.protection), null, 2)}\n`);
      return 0;
    }
    const { exitCode, report, results } = await run({
      repo: opts.repo,
      branches,
      only: opts.only,
      token: resolveToken(),
      requireReadable: Boolean(process.env.BRANCH_PROTECTION_TOKEN),
    });
    console.log(`Branch protection for ${opts.repo} vs ${path.relative(ROOT, opts.file) || opts.file}`);
    for (const line of report) console.log(line);
    const inCi = Boolean(process.env.GITHUB_ACTIONS);
    for (const r of results) {
      if (!inCi) break;
      if (r.outcome === "skipped") {
        console.log(`::notice title=Branch protection check skipped::${r.branch}: token lacks admin read`);
      } else if (r.outcome === "drift") {
        console.log(`::error title=Branch protection drift::${r.branch} differs from .github/branch-protection.json`);
      } else if (r.outcome === "pending") {
        console.log(`::notice title=Proposed protection not applied::${r.branch}`);
      }
    }
    if (opts.summary) {
      appendFileSync(opts.summary, `## Branch protection drift\n\n\`\`\`text\n${report.join("\n")}\n\`\`\`\n`);
    }
    return exitCode;
  } catch (err) {
    console.error(`check-branch-protection: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
