#!/usr/bin/env node
// Build the GitHub release body for a tag from CHANGELOG.md (#4278, PKG2-001).
//
// release.yml used to extract the version's section with an awk range whose
// end pattern (`## [`) also matched the start line, so the range was only the
// heading and the section always came back empty. The workflow then fell back
// to a raw `git log`, which for the first release is the whole history — far
// over GitHub's 125,000-character release-body limit, so `gh release create`
// failed. The curated v0.1.0 section is itself larger than that limit.
//
// This tool:
//   - extracts the body of the exact `## [<version>] - YYYY-MM-DD` section
//     (the heading release-check.sh requires; per-branch docs/changes/
//     fragments are consolidated into that section at release time, see
//     docs/changes/README.md). A pre-release tag maps to its own exact section
//     (`v0.2.0-beta.1` → `## [0.2.0-beta.1]`), since release.yml's version gate
//     requires the tag to equal the version files and release-check.sh requires
//     a dated section for that version;
//   - caps the body (CHANGELOG section or commit-log fallback) under the limit,
//     truncating at a line boundary and linking the full CHANGELOG.md at the tag,
//     and keeps the security marker if truncation drops a `### Security` section.
//
// CLI (used by release.yml's create-release job):
//   node extract-release-notes.mjs --version <v> --changelog CHANGELOG.md
//       prints the capped section; exits 2 (nothing printed) when the
//       changelog has no non-empty section for <v>.
//   node extract-release-notes.mjs --version <v> --fallback <file>
//       prints the capped contents of <file> (the commit-log fallback).

import { readFileSync } from "node:fs";
import { isMainModule } from "./is-main-module.mjs";
import { SECURITY_MARKER, hasSecuritySection } from "./emit-release-notes.mjs";

/** GitHub rejects a release body longer than this many characters. */
export const GITHUB_RELEASE_BODY_LIMIT = 125_000;

/**
 * The budget for the body this tool emits. release.yml appends more after it
 * (the security marker and the macOS unsigned-beta note), so leave headroom.
 */
export const RELEASE_BODY_BUDGET = 120_000;

/** Exit code for "no section for this version" (the caller then falls back). */
export const EXIT_NO_SECTION = 2;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripV = (version) => String(version).replace(/^v/, "");

/**
 * Extract the body of the `## [<version>]` section of a Keep a Changelog file.
 *
 * @param {unknown} changelog - CHANGELOG.md contents.
 * @param {string} version - The version, with or without a leading `v`.
 * @returns {string} The section body without its heading, trimmed of leading
 *   and trailing blank lines; "" when the section is missing or empty.
 */
export function extractChangelogSection(changelog, version) {
  if (typeof changelog !== "string") {
    return "";
  }
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const heading = new RegExp(`^## \\[${escapeRegExp(stripV(version))}\\](?:[ \\t].*)?$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return "";
  }
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) {
    end = lines.length;
  }
  const body = lines.slice(start + 1, end);
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  return body.join("\n");
}

/**
 * Cap a release body at `limit` characters. A body within the limit is
 * returned unchanged; otherwise whole lines are kept up to the limit and a
 * notice linking the full CHANGELOG.md is appended. When the dropped part held
 * the only `### Security` section, the self-update security marker is
 * prepended so the release is still flagged (emit-release-notes.mjs is
 * idempotent, so the later marking step does not duplicate it).
 *
 * @param {string} body - The release notes.
 * @param {{ url: string, limit?: number }} options - `url` of the full
 *   changelog; `limit` defaults to RELEASE_BODY_BUDGET.
 * @returns {string} A body of at most `limit` characters.
 */
export function capReleaseBody(body, { url, limit = RELEASE_BODY_BUDGET }) {
  const text = typeof body === "string" ? body : "";
  if (text.length <= limit) {
    return text;
  }
  const notice =
    `\n\n---\n\n_These release notes were truncated to fit GitHub's release-body ` +
    `limit. See the full changelog: ${url}_\n`;
  const marker = hasSecuritySection(text) ? `${SECURITY_MARKER}\n\n` : "";
  const room = Math.max(0, limit - notice.length - marker.length);

  let kept = text.slice(0, room);
  const lastNewline = kept.lastIndexOf("\n");
  if (lastNewline > 0) {
    kept = kept.slice(0, lastNewline);
  } else if (/[\uD800-\uDBFF]$/.test(kept)) {
    // A single over-long line: hard cut, but never split a surrogate pair.
    kept = kept.slice(0, -1);
  }
  kept = kept.replace(/\s+$/, "");

  const needsMarker =
    marker !== "" && !hasSecuritySection(kept) && !kept.startsWith(SECURITY_MARKER);
  return `${needsMarker ? marker : ""}${kept}${notice}`;
}

/**
 * The URL of CHANGELOG.md at the release tag, for the truncation notice.
 *
 * @param {string} version - The version, with or without a leading `v`.
 * @param {Record<string, string | undefined>} env - Environment (GitHub Actions
 *   sets GITHUB_SERVER_URL and GITHUB_REPOSITORY).
 * @returns {string}
 */
export function changelogUrl(version, env) {
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repo = env.GITHUB_REPOSITORY || "armaxri/termiHub";
  return `${server}/${repo}/blob/v${stripV(version)}/CHANGELOG.md`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      return null;
    }
    args[key.slice(2)] = value;
  }
  return args;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const usage =
    "usage: extract-release-notes.mjs --version <v> (--changelog <file> | --fallback <file>)";
  if (!args || !args.version || !args.changelog === !args.fallback) {
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }
  const url = changelogUrl(args.version, process.env);
  let body;
  if (args.changelog) {
    body = extractChangelogSection(readFileSync(args.changelog, "utf8"), args.version);
    if (body === "") {
      process.stderr.write(
        `No non-empty '## [${stripV(args.version)}]' section in ${args.changelog}.\n`
      );
      process.exit(EXIT_NO_SECTION);
    }
  } else {
    body = readFileSync(args.fallback, "utf8").replace(/\s+$/, "");
  }
  process.stdout.write(`${capReleaseBody(body, { url })}\n`);
}
