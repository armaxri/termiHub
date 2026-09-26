#!/usr/bin/env node
// Upstream drift + advisory watch for the vendored forks (SUP-005).
//
// A path / [patch.crates-io] fork is invisible to `cargo update`, Dependabot,
// cargo-audit and cargo-deny: none of them will ever tell us that upstream fixed
// a decoder bug or that a RustSec advisory names the crate we forked. This
// script closes that gap for every entry in vendor/vendored-forks.json by asking:
//
//   1. crates.io  — is there a stable upstream release newer than the version we
//                   last reviewed (`reviewed_version`)?
//   2. GitHub     — which upstream commits touching the forked crate
//                   (`upstream_path`) landed after the last reviewed commit
//                   (`reviewed_commit`)? Catches fixes before they are released.
//   3. OSV        — which advisories (OSV ingests the RustSec advisory-db and
//                   GHSA) affect the upstream crate at our `base_version`? Minus
//                   the ones listed in `acknowledged_advisories`.
//
// It needs no build and no Cargo toolchain. It writes a Markdown report and, on
// GitHub Actions, the outputs `attention` (true/false) and `digest` (stable hash
// of the findings, for idempotent issue updates) to $GITHUB_OUTPUT. The Vendored
// Forks workflow turns that into one tracking issue.
//
// Usage: node scripts/internal/vendored-fork-drift.mjs [--root <repo-dir>] [--out <report.md>]
// Env:   GITHUB_TOKEN / GH_TOKEN (optional locally; raises the GitHub API rate limit).
// Exit:  0 whether or not drift was found; 1 when an upstream query failed.
// The pure helpers are exported for unit testing (vendored-fork-drift.test.mjs).

import { appendFileSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import path from "path";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = "vendor/vendored-forks.json";
const USER_AGENT = "termiHub-vendored-fork-drift (https://github.com/armaxri/termiHub)";

/** Commits listed per fork in the report; the count is always complete. */
const MAX_LISTED_COMMITS = 30;

/**
 * Compare two semver versions by their numeric core; a pre-release sorts below
 * its release. Build metadata is ignored.
 *
 * @returns {number} negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = v.split("+")[0].split(/-(.*)/s);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * "https://github.com/owner/repo(.git)" -> "owner/repo".
 *
 * @param {string} url
 * @returns {string}
 */
export function githubSlug(url) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`not a GitHub repository URL: ${url}`);
  return match[1];
}

/**
 * Decide what needs attention for one fork, given the upstream data.
 *
 * @param {object} fork - one vendored-forks.json entry.
 * @param {object} upstream
 * @param {string | null} upstream.latestVersion - newest stable crates.io version.
 * @param {Array<{ sha: string, date: string, message: string, url: string }>} upstream.commits
 *   upstream commits touching the forked crate after `reviewed_commit`.
 * @param {Array<{ id: string, aliases: string[], summary: string, url: string }>} upstream.advisories
 *   advisories affecting the upstream crate at `base_version`.
 */
export function evaluateFork(fork, { latestVersion, commits, advisories }) {
  const acknowledged = new Set((fork.acknowledged_advisories ?? []).map((ack) => ack.id));
  const openAdvisories = advisories.filter(
    (adv) => !acknowledged.has(adv.id) && !adv.aliases.some((alias) => acknowledged.has(alias))
  );
  const newRelease =
    latestVersion !== null && compareVersions(latestVersion, fork.reviewed_version) > 0
      ? latestVersion
      : null;
  const reasons = [];
  if (openAdvisories.length > 0) {
    reasons.push(`${openAdvisories.length} advisory(ies) affect upstream ${fork.base_version}`);
  }
  if (newRelease) reasons.push(`upstream released ${newRelease}`);
  if (commits.length > 0) reasons.push(`${commits.length} new upstream commit(s)`);
  return {
    fork,
    latestVersion,
    newRelease,
    commits,
    openAdvisories,
    acknowledgedCount: advisories.length - openAdvisories.length,
    attention: reasons.length > 0,
    reasons,
  };
}

/**
 * Stable digest of the findings (not of timestamps), so the tracking issue is
 * only rewritten when something actually changed.
 *
 * @param {ReturnType<typeof evaluateFork>[]} results
 * @returns {string}
 */
export function findingsDigest(results) {
  const identity = results.map((r) => ({
    crate: r.fork.crate,
    release: r.newRelease,
    commits: r.commits.map((c) => c.sha),
    advisories: r.openAdvisories.map((a) => a.id).sort(),
  }));
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
}

/**
 * Render the Markdown report (also used verbatim as the tracking-issue body).
 *
 * @param {ReturnType<typeof evaluateFork>[]} results
 * @param {{ generatedAt: string, runUrl?: string | null, digest: string, repoUrl?: string }} meta
 * @returns {string}
 */
export function renderReport(
  results,
  { generatedAt, runUrl = null, digest, repoUrl = "https://github.com/armaxri/termiHub" }
) {
  const attention = results.filter((r) => r.attention);
  const out = [];
  out.push("## Vendored fork upstream drift");
  out.push("");
  out.push(
    attention.length > 0
      ? `**${attention.length} of ${results.length} vendored fork(s) need a review.**`
      : `All ${results.length} vendored fork(s) are level with the reviewed upstream state.`
  );
  out.push("");
  out.push(
    "Forks are consumed by path / `[patch.crates-io]`, so `cargo update`, cargo-audit and " +
      "cargo-deny never see upstream fixes or advisories for them (SUP-005). Register: " +
      `[\`vendor/vendored-forks.json\`](${repoUrl}/blob/develop/vendor/vendored-forks.json); process: ` +
      `[docs/supply-chain.md → Vendored forks](${repoUrl}/blob/develop/docs/supply-chain.md#vendored-forks).`
  );
  out.push("");
  out.push(
    "| Fork | Base | Reviewed up to | Latest on crates.io | New upstream commits | Open advisories |"
  );
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const f = r.fork;
    out.push(
      `| \`${f.path}\` | ${f.base_version} | ${f.reviewed_version} (\`${f.reviewed_commit.slice(0, 9)}\`) | ` +
        `${r.latestVersion ?? "?"}${r.newRelease ? " ⚠" : ""} | ${r.commits.length}${r.commits.length ? " ⚠" : ""} | ` +
        `${r.openAdvisories.length}${r.openAdvisories.length ? " ⚠" : ""} |`
    );
  }
  for (const r of results.filter((x) => x.attention)) {
    const f = r.fork;
    out.push("");
    out.push(`### \`${f.crate}\` — ${r.reasons.join("; ")}`);
    out.push("");
    out.push(`Upstream: ${f.upstream_repo}${f.upstream_path ? ` (\`${f.upstream_path}\`)` : ""}`);
    if (r.openAdvisories.length > 0) {
      out.push("");
      out.push(`**Advisories affecting upstream ${f.base_version}** (highest priority):`);
      out.push("");
      for (const adv of r.openAdvisories) {
        const aliases = adv.aliases.length ? ` (${adv.aliases.join(", ")})` : "";
        out.push(`- [${adv.id}](${adv.url})${aliases} — ${adv.summary || "no summary"}`);
      }
    }
    if (r.newRelease) {
      out.push("");
      out.push(
        `**New release:** ${f.crate} ${r.newRelease} ` +
          `(https://crates.io/crates/${f.watch.crates_io}/${r.newRelease}); reviewed up to ${f.reviewed_version}.`
      );
    }
    if (r.commits.length > 0) {
      out.push("");
      out.push(`**Upstream commits after \`${f.reviewed_commit.slice(0, 9)}\`:**`);
      out.push("");
      for (const c of r.commits.slice(0, MAX_LISTED_COMMITS)) {
        out.push(`- [\`${c.sha.slice(0, 9)}\`](${c.url}) ${c.date.slice(0, 10)} — ${c.message}`);
      }
      if (r.commits.length > MAX_LISTED_COMMITS) {
        out.push(`- … and ${r.commits.length - MAX_LISTED_COMMITS} more`);
      }
    }
  }
  if (attention.length > 0) {
    out.push("");
    out.push("### How to resolve");
    out.push("");
    out.push(
      "1. Read the listed commits/releases/advisories. Port every security or robustness fix " +
        "that reaches our fork, or re-base the fork on the new upstream release (then update " +
        "`base_*` in the register and the fork README)."
    );
    out.push(
      "2. Bump `reviewed_version` / `reviewed_commit` in `vendor/vendored-forks.json` to the " +
        "upstream state you reviewed."
    );
    out.push(
      "3. An advisory that does not apply to the fork goes into `acknowledged_advisories` with " +
        "a reason. The next weekly run closes this issue once nothing is left."
    );
  }
  out.push("");
  out.push(`_Generated ${generatedAt}${runUrl ? ` by [this run](${runUrl})` : ""}._`);
  out.push("");
  out.push(`<!-- vendored-fork-drift digest: ${digest} -->`);
  return `${out.join("\n")}\n`;
}

async function getJson(url, init = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers ?? {}) },
      });
      if (res.ok) return res.json();
      lastError = new Error(`${init.method ?? "GET"} ${url} -> HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
  throw lastError;
}

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Newest stable (non-yanked, non-pre-release) crates.io version of a crate. */
export async function fetchLatestVersion(crate) {
  const data = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(crate)}`);
  return data.crate?.max_stable_version ?? data.crate?.max_version ?? null;
}

/** Upstream commits touching the forked crate after `reviewed_commit`. */
export async function fetchNewCommits(fork) {
  const slug = githubSlug(fork.upstream_repo);
  const api = `https://api.github.com/repos/${slug}`;
  const headers = githubHeaders();
  const reviewed = await getJson(`${api}/commits/${fork.reviewed_commit}`, { headers });
  const since = reviewed.commit.committer.date;
  const commits = [];
  for (let page = 1; page <= 10; page++) {
    const params = new URLSearchParams({
      sha: fork.upstream_branch,
      since,
      per_page: "100",
      page: String(page),
    });
    if (fork.upstream_path) params.set("path", fork.upstream_path);
    const batch = await getJson(`${api}/commits?${params}`, { headers });
    for (const c of batch) {
      if (c.sha === fork.reviewed_commit) continue;
      // `since` is inclusive and compares committer dates: drop anything not
      // strictly newer than the reviewed commit.
      if (c.commit.committer.date <= since) continue;
      commits.push({
        sha: c.sha,
        date: c.commit.committer.date,
        message: c.commit.message.split("\n")[0],
        url: c.html_url,
      });
    }
    if (batch.length < 100) break;
  }
  return commits;
}

/** Advisories (RustSec + GHSA via OSV) affecting `crate` at `version`. */
export async function fetchAdvisories(crate, version, ecosystem = "crates.io") {
  const data = await getJson("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: { name: crate, ecosystem }, version }),
  });
  const byId = new Map();
  for (const vuln of data.vulns ?? []) {
    const aliases = vuln.aliases ?? [];
    // OSV returns both the RUSTSEC and the GHSA record for one issue; keep one.
    const all = [vuln.id, ...aliases];
    if (all.some((id) => byId.has(id))) continue;
    const rustsec = all.find((id) => id.startsWith("RUSTSEC-"));
    const id = rustsec ?? vuln.id;
    byId.set(id, {
      id,
      aliases: all.filter((alias) => alias !== id),
      summary: vuln.summary ?? "",
      url: rustsec
        ? `https://rustsec.org/advisories/${rustsec}`
        : `https://osv.dev/vulnerability/${vuln.id}`,
    });
  }
  return [...byId.values()];
}

async function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const root = path.resolve(flag("--root") ?? DEFAULT_ROOT);
  const outPath = flag("--out");
  const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST), "utf8"));

  const results = [];
  const errors = [];
  for (const fork of manifest.forks) {
    try {
      const [latestVersion, commits, advisories] = await Promise.all([
        fetchLatestVersion(fork.watch.crates_io),
        fetchNewCommits(fork),
        fetchAdvisories(fork.watch.crates_io, fork.base_version, fork.watch.osv_ecosystem),
      ]);
      results.push(evaluateFork(fork, { latestVersion, commits, advisories }));
    } catch (err) {
      errors.push(`${fork.path}: ${err.message}`);
    }
  }
  if (errors.length > 0) {
    // Never report "all clear" on a partial picture: fail the run instead.
    console.error("Upstream query failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    return 1;
  }

  const digest = findingsDigest(results);
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const repoUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
      : undefined;
  const report = renderReport(results, {
    generatedAt: new Date().toISOString(),
    runUrl,
    digest,
    repoUrl,
  });
  if (outPath) writeFileSync(outPath, report);
  else process.stdout.write(report);

  const attention = results.some((r) => r.attention);
  for (const r of results) {
    console.error(`${r.fork.crate}: ${r.attention ? r.reasons.join("; ") : "no drift"}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `attention=${attention}\ndigest=${digest}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    }
  );
}
